import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import { z } from 'zod';
import cliState from './cliState';
import { getEnvBool } from './envars';
import { importModule } from './esm';
import { getPrompt as getHeliconePrompt } from './integrations/helicone';
import { getPrompt as getLangfusePrompt } from './integrations/langfuse';
import { getPrompt as getPortkeyPrompt } from './integrations/portkey';
import logger from './logger';
import type EvalResult from './models/evalResult';
import { isPackagePath, loadFromPackage } from './providers/packageParser';
import { runPython } from './python/pythonUtils';
import telemetry from './telemetry';
import {
  type ApiProvider,
  type NunjucksFilterMap,
  type Prompt,
  TestCaseSchema,
  type TestSuite,
  type CompletedPrompt,
  type EvaluateResult,
  TestSuiteSchema,
  type TestCase,
} from './types';
import { renderVarsInObject } from './util';
import { isJavascriptFile, isImageFile, isVideoFile, isAudioFile } from './util/fileExtensions';
import invariant from './util/invariant';
import { getNunjucksEngine } from './util/templates';
import { transform } from './util/transform';

export type FileMetadata = Record<string, { path: string; type: string; format?: string }>;

export async function extractTextFromPDF(pdfPath: string): Promise<string> {
  logger.debug(`Extracting text from PDF: ${pdfPath}`);
  try {
    const { default: PDFParser } = await import('pdf-parse');
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await PDFParser(dataBuffer);
    return data.text.trim();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cannot find module 'pdf-parse'")) {
      throw new Error('pdf-parse is not installed. Please install it with: npm install pdf-parse');
    }
    throw new Error(
      `Failed to extract text from PDF ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveVariables(
  variables: Record<string, string | object>,
): Record<string, string | object> {
  let resolved = true;
  const regex = /\{\{\s*(\w+)\s*\}\}/; // Matches {{variableName}}, {{ variableName }}, etc.

  let iterations = 0;
  do {
    resolved = true;
    for (const key of Object.keys(variables)) {
      if (typeof variables[key] !== 'string') {
        continue;
      }
      const value = variables[key] as string;
      const match = regex.exec(value);
      if (match) {
        const [placeholder, varName] = match;
        if (variables[varName] === undefined) {
          // Do nothing - final nunjucks render will fail if necessary.
          // logger.warn(`Variable "${varName}" not found for substitution.`);
        } else {
          variables[key] = value.replace(placeholder, variables[varName] as string);
          resolved = false; // Indicate that we've made a replacement and should check again
        }
      }
    }
    iterations++;
  } while (!resolved && iterations < 5);

  return variables;
}

// Utility: Detect partial/unclosed Nunjucks tags and wrap in {% raw %} if needed
function autoWrapRawIfPartialNunjucks(prompt: string): string {
  // Detects any occurrence of an opening Nunjucks tag without a matching close
  // e.g. "{%" or "{{" not followed by a closing "%}" or "}}"
  const hasPartialTag = /({%[^%]*$|{{[^}]*$|{#[^#]*$)/m.test(prompt);
  const alreadyWrapped = /{\%\s*raw\s*\%}/.test(prompt) && /{\%\s*endraw\s*\%}/.test(prompt);
  if (hasPartialTag && !alreadyWrapped) {
    return `{% raw %}${prompt}{% endraw %}`;
  }
  return prompt;
}

/**
 * Collects metadata about file variables in the vars object.
 * @param vars The variables object containing potential file references
 * @returns An object mapping variable names to their file metadata
 */
export function collectFileMetadata(vars: Record<string, string | object>): FileMetadata {
  const fileMetadata: FileMetadata = {};

  for (const [varName, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value.startsWith('file://')) {
      const filePath = path.resolve(cliState.basePath || '', value.slice('file://'.length));
      const fileExtension = filePath.split('.').pop() || '';

      if (isImageFile(filePath)) {
        fileMetadata[varName] = {
          path: value, // Keep the original file:// notation
          type: 'image',
          format: fileExtension,
        };
      } else if (isVideoFile(filePath)) {
        fileMetadata[varName] = {
          path: value,
          type: 'video',
          format: fileExtension,
        };
      } else if (isAudioFile(filePath)) {
        fileMetadata[varName] = {
          path: value,
          type: 'audio',
          format: fileExtension,
        };
      }
    }
  }

  return fileMetadata;
}

export async function renderPrompt(
  prompt: Prompt,
  vars: Record<string, string | object>,
  nunjucksFilters?: NunjucksFilterMap,
  provider?: ApiProvider,
): Promise<string> {
  const nunjucks = getNunjucksEngine(nunjucksFilters);

  let basePrompt = prompt.raw;

  // Load files
  for (const [varName, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value.startsWith('file://')) {
      const basePath = cliState.basePath || '';
      const filePath = path.resolve(process.cwd(), basePath, value.slice('file://'.length));
      const fileExtension = filePath.split('.').pop();

      logger.debug(`Loading var ${varName} from file: ${filePath}`);
      if (isJavascriptFile(filePath)) {
        const javascriptOutput = (await (
          await importModule(filePath)
        )(varName, basePrompt, vars, provider)) as {
          output?: string;
          error?: string;
        };
        if (javascriptOutput.error) {
          throw new Error(`Error running ${filePath}: ${javascriptOutput.error}`);
        }
        if (!javascriptOutput.output) {
          throw new Error(
            `Expected ${filePath} to return { output: string } but got ${javascriptOutput}`,
          );
        }
        vars[varName] = javascriptOutput.output;
      } else if (fileExtension === 'py') {
        const pythonScriptOutput = (await runPython(filePath, 'get_var', [
          varName,
          basePrompt,
          vars,
        ])) as { output?: any; error?: string };
        if (pythonScriptOutput.error) {
          throw new Error(`Error running Python script ${filePath}: ${pythonScriptOutput.error}`);
        }
        if (!pythonScriptOutput.output) {
          throw new Error(`Python script ${filePath} did not return any output`);
        }
        invariant(
          typeof pythonScriptOutput.output === 'string',
          `pythonScriptOutput.output must be a string. Received: ${typeof pythonScriptOutput.output}`,
        );
        vars[varName] = pythonScriptOutput.output.trim();
      } else if (fileExtension === 'yaml' || fileExtension === 'yml') {
        vars[varName] = JSON.stringify(
          yaml.load(fs.readFileSync(filePath, 'utf8')) as string | object,
        );
      } else if (fileExtension === 'pdf' && !getEnvBool('PROMPTFOO_DISABLE_PDF_AS_TEXT')) {
        telemetry.recordOnce('feature_used', {
          feature: 'extract_text_from_pdf',
        });
        vars[varName] = await extractTextFromPDF(filePath);
      } else if (
        (isImageFile(filePath) || isVideoFile(filePath) || isAudioFile(filePath)) &&
        !getEnvBool('PROMPTFOO_DISABLE_MULTIMEDIA_AS_BASE64')
      ) {
        const fileType = isImageFile(filePath)
          ? 'image'
          : isVideoFile(filePath)
            ? 'video'
            : 'audio';

        telemetry.recordOnce('feature_used', {
          feature: `load_${fileType}_as_base64`,
        });

        logger.debug(`Loading ${fileType} as base64: ${filePath}`);
        try {
          const fileBuffer = fs.readFileSync(filePath);
          vars[varName] = fileBuffer.toString('base64');
        } catch (error) {
          throw new Error(
            `Failed to load ${fileType} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        vars[varName] = fs.readFileSync(filePath, 'utf8').trim();
      }
    } else if (isPackagePath(value)) {
      const basePath = cliState.basePath || '';
      const javascriptOutput = (await (
        await loadFromPackage(value, basePath)
      )(varName, basePrompt, vars, provider)) as {
        output?: string;
        error?: string;
      };
      if (javascriptOutput.error) {
        throw new Error(`Error running ${value}: ${javascriptOutput.error}`);
      }
      if (!javascriptOutput.output) {
        throw new Error(
          `Expected ${value} to return { output: string } but got ${javascriptOutput}`,
        );
      }
      vars[varName] = javascriptOutput.output;
    }
  }

  // Apply prompt functions
  if (prompt.function) {
    const result = await prompt.function({ vars, provider });
    if (typeof result === 'string') {
      basePrompt = result;
    } else if (typeof result === 'object') {
      // Check if it's using the structured PromptFunctionResult format
      if ('prompt' in result) {
        basePrompt =
          typeof result.prompt === 'string' ? result.prompt : JSON.stringify(result.prompt);

        // Merge config if provided
        if (result.config) {
          prompt.config = {
            ...(prompt.config || {}),
            ...result.config,
          };
        }
      } else {
        // Direct object/array format
        basePrompt = JSON.stringify(result);
      }
    } else {
      throw new Error(`Prompt function must return a string or object, got ${typeof result}`);
    }
  }

  // Remove any trailing newlines from vars, as this tends to be a footgun for JSON prompts.
  for (const key of Object.keys(vars)) {
    if (typeof vars[key] === 'string') {
      vars[key] = (vars[key] as string).replace(/\n$/, '');
    }
  }
  // Resolve variable mappings
  resolveVariables(vars);
  // Third party integrations
  if (prompt.raw.startsWith('portkey://')) {
    const portKeyResult = await getPortkeyPrompt(prompt.raw.slice('portkey://'.length), vars);
    return JSON.stringify(portKeyResult.messages);
  } else if (prompt.raw.startsWith('langfuse://')) {
    const langfusePrompt = prompt.raw.slice('langfuse://'.length);

    // we default to "text" type.
    const [helper, version, promptType = 'text'] = langfusePrompt.split(':');
    if (promptType !== 'text' && promptType !== 'chat') {
      throw new Error('Unknown promptfoo prompt type');
    }

    const langfuseResult = await getLangfusePrompt(
      helper,
      vars,
      promptType,
      version === 'latest' ? undefined : Number(version),
    );
    return langfuseResult;
  } else if (prompt.raw.startsWith('helicone://')) {
    const heliconePrompt = prompt.raw.slice('helicone://'.length);
    const [id, version] = heliconePrompt.split(':');
    const [majorVersion, minorVersion] = version ? version.split('.') : [undefined, undefined];
    const heliconeResult = await getHeliconePrompt(
      id,
      vars,
      majorVersion === undefined ? undefined : Number(majorVersion),
      minorVersion === undefined ? undefined : Number(minorVersion),
    );
    return heliconeResult;
  }
  // Render prompt
  try {
    if (getEnvBool('PROMPTFOO_DISABLE_JSON_AUTOESCAPE')) {
      // Pre-process: auto-wrap in {% raw %} if partial Nunjucks tags detected
      basePrompt = autoWrapRawIfPartialNunjucks(basePrompt);
      return nunjucks.renderString(basePrompt, vars);
    }

    const parsed = JSON.parse(basePrompt);
    // The _raw_ prompt is valid JSON. That means that the user likely wants to substitute vars _within_ the JSON itself.
    // Recursively walk the JSON structure. If we find a string, render it with nunjucks.
    return JSON.stringify(renderVarsInObject(parsed, vars), null, 2);
  } catch {
    // Vars values can be template strings, so we need to render them first:
    const renderedVars = Object.fromEntries(
      Object.entries(vars).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? nunjucks.renderString(autoWrapRawIfPartialNunjucks(value), vars)
          : value,
      ]),
    );

    // Pre-process: auto-wrap in {% raw %} if partial Nunjucks tags detected
    basePrompt = autoWrapRawIfPartialNunjucks(basePrompt);
    // Note: Explicitly not using `renderVarsInObject` as it will re-call `renderString`; each call will
    // strip Nunjucks Tags, which breaks using raw (https://mozilla.github.io/nunjucks/templating.html#raw) e.g.
    // {% raw %}{{some_string}}{% endraw %} -> {{some_string}} -> ''
    return nunjucks.renderString(basePrompt, renderedVars);
  }
}

// ================================
// Extension Hooks
// ================================

// TODO(chore): Move the extension hooks logic into a separate file.

const BeforeAllExtensionHookContextSchema = z.object({
  suite: TestSuiteSchema,
});

const BeforeEachExtensionHookContextSchema = z.object({
  test: TestCaseSchema,
});

/**
 * Defines the set of fields on BeforeAllExtensionHookContextSchema that may be mutated by the extension hook.
 */
const MutableBeforeAllExtensionHookContextSchema = z.object({
  suite: z.object({
    prompts: TestSuiteSchema.shape.prompts,
    providerPromptMap: TestSuiteSchema.shape.providerPromptMap,
    tests: TestSuiteSchema.shape.tests,
    scenarios: TestSuiteSchema.shape.scenarios,
    defaultTest: TestSuiteSchema.shape.defaultTest,
    nunjucksFilters: TestSuiteSchema.shape.nunjucksFilters,
    derivedMetrics: TestSuiteSchema.shape.derivedMetrics,
    redteam: TestSuiteSchema.shape.redteam,
  }),
});

const MutableBeforeEachExtensionHookContextSchema = z
  .object({
    test: TestCaseSchema,
  })
  .strict();

type BeforeAllExtensionHookContext = z.infer<typeof BeforeAllExtensionHookContextSchema>;
type BeforeEachExtensionHookContext = z.infer<typeof BeforeEachExtensionHookContextSchema>;

type AfterEachExtensionHookContext = {
  test: TestCase;
  result: EvaluateResult;
};

type AfterAllExtensionHookContext = {
  suite: TestSuite;
  results: EvalResult[];
  prompts: CompletedPrompt[];
};

// Maps hook names to their context types.
type HookContextMap = {
  beforeAll: BeforeAllExtensionHookContext;
  beforeEach: BeforeEachExtensionHookContext;
  afterEach: AfterEachExtensionHookContext;
  afterAll: AfterAllExtensionHookContext;
};

export type ExtensionHookContext =
  | BeforeAllExtensionHookContext
  | BeforeEachExtensionHookContext
  | AfterEachExtensionHookContext
  | AfterAllExtensionHookContext;

/**
 * Runs extension hooks for the given hook name and context. The hook will be called with the context object,
 * and can update the context object to persist data into provider calls.
 * @param extensions - An array of extension paths, or null.
 * @param hookName - The name of the hook to run.
 * @param context - The context object to pass to the hook. T depends on the type of the hook.
 * @returns A Promise that resolves with one of the following:
 *  - The original context object, if no extensions are provided OR if the returned context is not valid.
 *  - The updated context object, if the extension hook returns a valid context object. The updated context,
 *    if defined, must conform to the type T; otherwise, a validation error is thrown.
 */
export async function runExtensionHook<HookName extends keyof HookContextMap>(
  extensions: string[] | null | undefined,
  hookName: HookName,
  context: HookContextMap[HookName],
): Promise<HookContextMap[HookName]> {
  if (!extensions || !Array.isArray(extensions) || extensions.length === 0) {
    return context;
  }

  // Guard against runtime type drift by validating the context object matches the expected schema.
  // This ensures that the context object is valid prior to passing it to the extension hook, upstreaming
  // type errors.
  switch (hookName) {
    case 'beforeAll': {
      const parsed = BeforeAllExtensionHookContextSchema.safeParse(context);
      invariant(
        parsed.success,
        `Invalid context passed to beforeAll hook: ${parsed.error?.message}`,
      );
      break;
    }
    case 'beforeEach': {
      const parsed = BeforeEachExtensionHookContextSchema.safeParse(context);
      invariant(
        parsed.success,
        `Invalid context passed to beforeEach hook: ${parsed.error?.message}`,
      );
      break;
    }
  }

  // TODO(Will): It would be nice if this logged the hooks used.
  telemetry.recordOnce('feature_used', {
    feature: 'extension_hook',
  });

  let updatedContext: HookContextMap[HookName] = { ...context };

  for (const extension of extensions) {
    invariant(typeof extension === 'string', 'extension must be a string');
    logger.debug(`Running extension hook ${hookName} with context ${JSON.stringify(context)}`);

    const extensionReturnValue = await transform(extension, hookName, context, false);

    // If the extension hook returns a value, update the context with the value's mutable fields.
    // This also provides backwards compatibility for extension hooks that do not return a value.
    if (extensionReturnValue) {
      switch (hookName) {
        case 'beforeAll': {
          const parsed = MutableBeforeAllExtensionHookContextSchema.safeParse(extensionReturnValue);
          if (parsed.success) {
            (updatedContext as BeforeAllExtensionHookContext) = {
              suite: {
                ...(context as BeforeAllExtensionHookContext).suite,
                ...parsed.data.suite,
              },
            };
          } else {
            logger.error(parsed.error.message);
            throw new Error(
              `[${extension}] Invalid context returned by beforeAll hook: ${parsed.error.message}`,
            );
          }
          break;
        }
        case 'beforeEach': {
          const parsed =
            MutableBeforeEachExtensionHookContextSchema.safeParse(extensionReturnValue);
          if (parsed.success) {
            (updatedContext as BeforeEachExtensionHookContext) = { test: parsed.data.test };
          } else {
            logger.error(parsed.error.message);
            throw new Error(
              `[${extension}] Invalid context returned by beforeEach hook: ${parsed.error.message}`,
            );
          }
          break;
        }
      }
    }
  }

  return updatedContext;
}
