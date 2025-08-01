import { randomUUID } from 'crypto';
import fs from 'fs';
import glob from 'glob';
import { FILE_METADATA_KEY } from '../src/constants';
import {
  calculateThreadsPerBar,
  evaluate,
  generateVarCombinations,
  isAllowedPrompt,
  newTokenUsage,
  runEval,
} from '../src/evaluator';
import { runExtensionHook } from '../src/evaluatorHelpers';
import logger from '../src/logger';
import { runDbMigrations } from '../src/migrate';
import Eval from '../src/models/eval';
import { type ApiProvider, type TestSuite, type Prompt, ResultFailureReason } from '../src/types';
import { processConfigFileReferences } from '../src/util/fileReference';
import { sleep } from '../src/util/time';

jest.mock('../src/util/fileReference', () => ({
  ...jest.requireActual('../src/util/fileReference'),
  processConfigFileReferences: jest.fn().mockImplementation(async (config) => {
    if (
      typeof config === 'object' &&
      config !== null &&
      config.tests &&
      Array.isArray(config.tests)
    ) {
      const result = {
        ...config,
        tests: config.tests.map((test: any) => {
          return {
            ...test,
            vars:
              test.vars.var1 === 'file://test/fixtures/test_file.txt'
                ? {
                    var1: '<h1>Sample Report</h1><p>This is a test report with some data for the year 2023.</p>',
                  }
                : test.vars,
          };
        }),
      };
      return result;
    }
    return config;
  }),
}));

jest.mock('proxy-agent', () => ({
  ProxyAgent: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('glob', () => ({
  globSync: jest.fn().mockImplementation((pattern) => {
    if (pattern.includes('test/fixtures/test_file.txt')) {
      return [pattern];
    }
    return [];
  }),
}));

jest.mock('../src/esm');

jest.mock('../src/evaluatorHelpers', () => ({
  ...jest.requireActual('../src/evaluatorHelpers'),
  runExtensionHook: jest.fn().mockImplementation((extensions, hookName, context) => context),
}));

jest.mock('../src/util/time', () => ({
  ...jest.requireActual('../src/util/time'),
  sleep: jest.fn(),
}));

jest.mock('../src/util/fileExtensions', () => ({
  isImageFile: jest
    .fn()
    .mockImplementation((filePath) => filePath.endsWith('.jpg') || filePath.endsWith('.png')),
  isVideoFile: jest.fn().mockImplementation((filePath) => filePath.endsWith('.mp4')),
  isAudioFile: jest.fn().mockImplementation((filePath) => filePath.endsWith('.mp3')),
  isJavascriptFile: jest.fn().mockReturnValue(false),
}));

jest.mock('../src/util/functions/loadFunction', () => ({
  ...jest.requireActual('../src/util/functions/loadFunction'),
  loadFunction: jest.fn().mockImplementation((options) => {
    if (options.filePath.includes('scoring')) {
      return Promise.resolve((metrics: Record<string, number>) => ({
        pass: true,
        score: 0.75,
        reason: 'Custom scoring reason',
      }));
    }
    return Promise.resolve(() => {});
  }),
  parseFileUrl: jest.requireActual('../src/util/functions/loadFunction').parseFileUrl,
}));

const mockApiProvider: ApiProvider = {
  id: jest.fn().mockReturnValue('test-provider'),
  callApi: jest.fn().mockResolvedValue({
    output: 'Test output',
    tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
  }),
};

const mockApiProvider2: ApiProvider = {
  id: jest.fn().mockReturnValue('test-provider-2'),
  callApi: jest.fn().mockResolvedValue({
    output: 'Test output',
    tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
  }),
};

const mockReasoningApiProvider: ApiProvider = {
  id: jest.fn().mockReturnValue('test-reasoning-provider'),
  callApi: jest.fn().mockResolvedValue({
    output: 'Test output',
    tokenUsage: {
      total: 21,
      prompt: 9,
      completion: 12,
      cached: 0,
      numRequests: 1,
      completionDetails: { reasoning: 11, acceptedPrediction: 12, rejectedPrediction: 13 },
    },
  }),
};

const mockGradingApiProviderPasses: ApiProvider = {
  id: jest.fn().mockReturnValue('test-grading-provider'),
  callApi: jest.fn().mockResolvedValue({
    output: JSON.stringify({ pass: true, reason: 'Test grading output' }),
    tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
  }),
};

const mockGradingApiProviderFails: ApiProvider = {
  id: jest.fn().mockReturnValue('test-grading-provider'),
  callApi: jest.fn().mockResolvedValue({
    output: JSON.stringify({ pass: false, reason: 'Grading failed reason' }),
    tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
  }),
};

function toPrompt(text: string): Prompt {
  return { raw: text, label: text };
}

describe('evaluator', () => {
  beforeAll(async () => {
    await runDbMigrations();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (global.gc) {
      global.gc(); // Force garbage collection
    }
  });

  afterAll(() => {
    // Clear all module mocks to prevent any lingering state
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('evaluate with vars', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }} {{ var2 }}')],
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(mockApiProvider.callApi).toHaveBeenCalledWith(
      'Test prompt value1 value2',
      expect.objectContaining({
        vars: { var1: 'value1', var2: 'value2' },
        test: testSuite.tests![0],
        prompt: expect.any(Object),
      }),
      undefined,
    );
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt value1 value2');
    expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1 }} {{ var2 }}');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with vars - no escaping', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }} {{ var2 }}')],
      tests: [
        {
          vars: { var1: '1 < 2', var2: 'he said "hello world"...' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt 1 < 2 he said "hello world"...');
    expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1 }} {{ var2 }}');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with vars as object', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1.prop1 }} {{ var2 }}')],
      tests: [
        {
          vars: { var1: { prop1: 'value1' }, var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt value1 value2');
    expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1.prop1 }} {{ var2 }}');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with vars from file', async () => {
    const originalReadFileSync = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('test_file.txt')) {
        return '<h1>Sample Report</h1><p>This is a test report with some data for the year 2023.</p>';
      }
      return originalReadFileSync(path);
    });

    const evalHelpers = await import('../src/evaluatorHelpers');
    const originalRenderPrompt = evalHelpers.renderPrompt;

    const mockRenderPrompt = jest.spyOn(evalHelpers, 'renderPrompt');
    mockRenderPrompt.mockImplementation(async (prompt, vars) => {
      if (prompt.raw.includes('{{ var1 }}')) {
        return 'Test prompt <h1>Sample Report</h1><p>This is a test report with some data for the year 2023.</p>';
      }
      return originalRenderPrompt(prompt, vars);
    });

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }}')],
      tests: [
        {
          vars: { var1: 'file://test/fixtures/test_file.txt' },
        },
      ],
    };

    try {
      const processedTestSuite = await processConfigFileReferences(testSuite);
      const evalRecord = await Eval.create({}, processedTestSuite.prompts, { id: randomUUID() });
      await evaluate(processedTestSuite, evalRecord, {});
      const summary = await evalRecord.toEvaluateSummary();

      expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
      expect(mockApiProvider.callApi).toHaveBeenCalledWith(
        'Test prompt <h1>Sample Report</h1><p>This is a test report with some data for the year 2023.</p>',
        expect.anything(),
        undefined,
      );

      expect(summary.stats.successes).toBe(1);
      expect(summary.stats.failures).toBe(0);
      expect(summary.results[0].prompt.raw).toBe(
        'Test prompt <h1>Sample Report</h1><p>This is a test report with some data for the year 2023.</p>',
      );
      expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1 }}');
      expect(summary.results[0].response?.output).toBe('Test output');
    } finally {
      mockRenderPrompt.mockRestore();
      fs.readFileSync = originalReadFileSync;
    }
  });

  it('evaluate with named prompt', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [{ raw: 'Test prompt {{ var1 }} {{ var2 }}', label: 'test display name' }],
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt value1 value2');
    expect(summary.results[0].prompt.label).toBe('test display name');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with multiple vars', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }} {{ var2 }}')],
      tests: [
        {
          vars: { var1: ['value1', 'value3'], var2: ['value2', 'value4'] },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(4);
    expect(summary.stats.successes).toBe(4);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 40,
      prompt: 20,
      completion: 20,
      cached: 0,
      numRequests: 4,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt value1 value2');
    expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1 }} {{ var2 }}');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with multiple providers', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider, mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }} {{ var2 }}')],
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
    expect(summary.stats.successes).toBe(2);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 20,
      prompt: 10,
      completion: 10,
      cached: 0,
      numRequests: 2,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt value1 value2');
    expect(summary.results[0].prompt.label).toBe('Test prompt {{ var1 }} {{ var2 }}');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate without tests', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt');
    expect(summary.results[0].prompt.label).toBe('Test prompt');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate without tests with multiple providers', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider, mockApiProvider, mockApiProvider],
      prompts: [toPrompt('Test prompt')],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(3);
    expect(summary.stats.successes).toBe(3);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 30,
      prompt: 15,
      completion: 15,
      cached: 0,
      numRequests: 3,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt');
    expect(summary.results[0].prompt.label).toBe('Test prompt');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate for reasoning', async () => {
    const testSuite: TestSuite = {
      providers: [mockReasoningApiProvider],
      prompts: [toPrompt('Test prompt')],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockReasoningApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 21,
      prompt: 9,
      completion: 12,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 11,
        acceptedPrediction: 12,
        rejectedPrediction: 13,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt');
    expect(summary.results[0].prompt.label).toBe('Test prompt');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with expected value matching output', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Test output',
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].success).toBe(true);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with expected value not matching output', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Different output',
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(0);
    expect(summary.stats.failures).toBe(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with fn: expected value', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'javascript',
              value: 'output === "Test output";',
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].success).toBe(true);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with fn: expected value not matching output', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'javascript',
              value: 'output === "Different output";',
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(0);
    expect(summary.stats.failures).toBe(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with grading expected value', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'llm-rubric',
              value: 'output is a test output',
            },
          ],
        },
      ],
      defaultTest: {
        options: {
          provider: mockGradingApiProviderPasses,
        },
      },
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].success).toBe(true);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with grading expected value does not pass', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'llm-rubric',
              value: 'output is a test output',
            },
          ],
        },
      ],
      defaultTest: {
        options: {
          provider: mockGradingApiProviderFails,
        },
      },
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(0);
    expect(summary.stats.failures).toBe(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with transform option - default test', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      defaultTest: {
        options: {
          transform: 'output + " postprocessed"',
        },
      },
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Test output postprocessed');
  });

  it('evaluate with transform option - single test', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Test output postprocessed',
            },
          ],
          options: {
            transform: 'output + " postprocessed"',
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Test output postprocessed');
  });

  it('evaluate with transform option - json provider', async () => {
    const mockApiJsonProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-json'),
      callApi: jest.fn().mockResolvedValue({
        output: '{"output": "testing", "value": 123}',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiJsonProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: '123',
            },
          ],
          options: {
            transform: `JSON.parse(output).value`,
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiJsonProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe(123);
  });

  it('evaluate with provider transform', async () => {
    const mockApiProviderWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-transform'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Original output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
      transform: '`Transformed: ${output}`',
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithTransform],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Transformed: Original output',
            },
          ],
          options: {}, // No test transform, relying on provider's transform
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProviderWithTransform.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Transformed: Original output');
  });

  it('evaluate with vars transform', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Hello {{ name }}, your age is {{ age }}')],
      tests: [
        {
          vars: { name: 'Alice', age: 30 },
        },
        {
          vars: { name: 'Bob', age: 25 },
          options: {
            transformVars: '{ ...vars, age: vars.age + 5 }',
          },
        },
      ],
      defaultTest: {
        options: {
          transformVars: '{ ...vars, name: vars.name.toUpperCase() }',
        },
      },
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();
    expect(summary).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({
          successes: 2,
          failures: 0,
        }),
        results: expect.arrayContaining([
          expect.objectContaining({
            prompt: expect.objectContaining({
              raw: 'Hello ALICE, your age is 30',
              label: 'Hello {{ name }}, your age is {{ age }}',
            }),
            response: expect.objectContaining({
              output: 'Test output',
            }),
          }),
          expect.objectContaining({
            // NOTE: test overrides defaultTest transform. Bob not BOB
            prompt: expect.objectContaining({
              raw: 'Hello Bob, your age is 30',
            }),
            response: expect.objectContaining({
              output: 'Test output',
            }),
            vars: {
              name: 'Bob',
              age: 30,
            },
          }),
        ]),
      }),
    );

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
  });

  it('evaluate with context in vars transform in defaultTest', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Hello {{ name }}, your age is {{ age }}')],
      defaultTest: {
        options: {
          transformVars: `return {
              ...vars,
              // Test that context.uuid is available
              id: context.uuid,
              // Test that context.prompt is available but empty
              hasPrompt: Boolean(context.prompt)
            }`,
        },
      },
      tests: [
        {
          vars: {
            name: 'Alice',
            age: 25,
          },
        },
      ],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({
          successes: 1,
          failures: 0,
        }),
        results: expect.arrayContaining([
          expect.objectContaining({
            vars: expect.objectContaining({
              id: expect.stringMatching(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
              ),
              hasPrompt: true,
            }),
          }),
        ]),
      }),
    );

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluate with provider transform and test transform', async () => {
    const mockApiProviderWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-transform'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Original output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
      transform: '`ProviderTransformed: ${output}`',
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithTransform],
      prompts: [toPrompt('Test prompt')],
      defaultTest: {
        options: {
          // overridden by the test transform
          transform: '"defaultTestTransformed " + output',
        },
      },
      tests: [
        {
          assert: [
            {
              type: 'equals',
              // Order of transforms: 1. Provider transform 2. Test transform (or defaultTest transform, if test transform unset)
              value: 'testTransformed ProviderTransformed: Original output',
            },
          ],
          // This transform overrides the defaultTest transform
          options: { transform: '"testTransformed " + output' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({
          successes: 1,
          failures: 0,
        }),
        results: expect.arrayContaining([
          expect.objectContaining({
            response: expect.objectContaining({
              output: 'testTransformed ProviderTransformed: Original output',
            }),
          }),
        ]),
      }),
    );

    expect(mockApiProviderWithTransform.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluate with providerPromptMap', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt 1'), toPrompt('Test prompt 2')],
      providerPromptMap: {
        'test-provider': ['Test prompt 1'],
      },
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.stats.tokenUsage).toEqual({
      total: 10,
      prompt: 5,
      completion: 5,
      cached: 0,
      numRequests: 1,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
      },
    });
    expect(summary.results[0].prompt.raw).toBe('Test prompt 1');
    expect(summary.results[0].prompt.label).toBe('Test prompt 1');
    expect(summary.results[0].response?.output).toBe('Test output');
  });

  it('evaluate with allowed prompts filtering', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [
        { raw: 'Test prompt 1', label: 'prompt1' },
        { raw: 'Test prompt 2', label: 'prompt2' },
        { raw: 'Test prompt 3', label: 'group1:prompt3' },
      ],
      providerPromptMap: {
        'test-provider': ['prompt1', 'group1'],
      },
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      stats: {
        successes: 2,
        failures: 0,
      },
      results: [{ prompt: { label: 'prompt1' } }, { prompt: { label: 'group1:prompt3' } }],
    });
  });

  it('evaluate with scenarios', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest
        .fn()
        .mockResolvedValueOnce({
          output: 'Hola mundo',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: 'Bonjour le monde',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ language }}')],
      scenarios: [
        {
          config: [
            {
              vars: {
                language: 'Spanish',
                expectedHelloWorld: 'Hola mundo',
              },
            },
            {
              vars: {
                language: 'French',
                expectedHelloWorld: 'Bonjour le monde',
              },
            },
          ],
          tests: [
            {
              assert: [
                {
                  type: 'equals',
                  value: '{{expectedHelloWorld}}',
                },
              ],
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
    expect(summary.stats.successes).toBe(2);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Hola mundo');
    expect(summary.results[1].response?.output).toBe('Bonjour le monde');
  });

  it('evaluate with scenarios and multiple vars', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest
        .fn()
        .mockResolvedValueOnce({
          output: 'Spanish Hola',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: 'Spanish Bonjour',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: 'French Hola',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: 'French Bonjour',
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        }),
    };
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ language }} {{ greeting }}')],
      scenarios: [
        {
          config: [
            {
              vars: {
                language: ['Spanish', 'French'],
                greeting: ['Hola', 'Bonjour'],
              },
            },
          ],
          tests: [
            {
              assert: [
                {
                  type: 'equals',
                  value: '{{language}} {{greeting}}',
                },
              ],
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(4);
    expect(summary.stats.successes).toBe(4);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Spanish Hola');
    expect(summary.results[1].response?.output).toBe('Spanish Bonjour');
    expect(summary.results[2].response?.output).toBe('French Hola');
    expect(summary.results[3].response?.output).toBe('French Bonjour');
  });

  it('evaluate with scenarios and defaultTest', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Hello, World',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      defaultTest: {
        metadata: { defaultKey: 'defaultValue' },
        assert: [
          {
            type: 'starts-with',
            value: 'Hello',
          },
        ],
      },
      scenarios: [
        {
          config: [{ metadata: { configKey: 'configValue' } }],
          tests: [{ metadata: { testKey: 'testValue' } }],
        },
        {
          config: [
            {
              assert: [
                {
                  type: 'contains',
                  value: ',',
                },
              ],
            },
          ],
          tests: [
            {
              assert: [
                {
                  type: 'icontains',
                  value: 'world',
                },
              ],
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();
    expect(summary).toMatchObject({
      stats: {
        successes: 2,
        failures: 0,
      },
      results: expect.arrayContaining([
        expect.objectContaining({
          gradingResult: expect.objectContaining({
            componentResults: expect.arrayContaining([expect.anything()]),
          }),
        }),
        expect.objectContaining({
          gradingResult: expect.objectContaining({
            componentResults: expect.arrayContaining([
              expect.anything(),
              expect.anything(),
              expect.anything(),
            ]),
          }),
        }),
      ]),
    });

    expect(summary.results[0].testCase.metadata).toEqual({
      defaultKey: 'defaultValue',
      configKey: 'configValue',
      testKey: 'testValue',
    });

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
  });

  it('evaluator should correctly count named scores based on contributing assertions', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt for namedScoresCount')],
      tests: [
        {
          vars: { var1: 'value1' },
          assert: [
            {
              type: 'equals',
              value: 'Test output',
              metric: 'Accuracy',
            },
            {
              type: 'contains',
              value: 'Test',
              metric: 'Accuracy',
            },
            {
              type: 'javascript',
              value: 'output.length > 0',
              metric: 'Completeness',
            },
          ],
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.results).toHaveLength(1);
    const result = summary.results[0];

    // Use toMatchObject pattern to avoid conditional expects
    expect(evalRecord.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: result.provider.id,
          metrics: expect.objectContaining({
            namedScoresCount: expect.objectContaining({
              Accuracy: 2,
              Completeness: 1,
            }),
          }),
        }),
      ]),
    );
  });

  it('merges metadata correctly for regular tests', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      defaultTest: {
        metadata: { defaultKey: 'defaultValue' },
      },
      tests: [
        {
          metadata: { testKey: 'testValue' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const results = await evalRecord.getResults();
    expect(results[0].testCase.metadata).toEqual({
      defaultKey: 'defaultValue',
      testKey: 'testValue',
    });
  });

  it('merges response metadata with test metadata', async () => {
    const mockProviderWithMetadata: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-with-metadata'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        metadata: { responseKey: 'responseValue' },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockProviderWithMetadata],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          metadata: { testKey: 'testValue' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const results = await evalRecord.getResults();

    // Check that both test metadata and response metadata are present in the result
    expect(results[0].metadata).toEqual({
      testKey: 'testValue',
      responseKey: 'responseValue',
      [FILE_METADATA_KEY]: {},
    });
  });

  it('evaluate with _conversation variable', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockImplementation((prompt) =>
        Promise.resolve({
          output: prompt,
          tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        }),
      ),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('{{ var1 }} {{ _conversation[0].output }}')],
      tests: [
        {
          vars: { var1: 'First run' },
        },
        {
          vars: { var1: 'Second run' },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(2);
    expect(summary.stats.successes).toBe(2);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('First run ');
    expect(summary.results[1].response?.output).toBe('Second run First run ');
  });

  it('evaluate with labeled and unlabeled providers and providerPromptMap', async () => {
    const mockLabeledProvider: ApiProvider = {
      id: () => 'labeled-provider-id',
      label: 'Labeled Provider',
      callApi: jest.fn().mockResolvedValue({
        output: 'Labeled Provider Output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const mockUnlabeledProvider: ApiProvider = {
      id: () => 'unlabeled-provider-id',
      callApi: jest.fn().mockResolvedValue({
        output: 'Unlabeled Provider Output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockLabeledProvider, mockUnlabeledProvider],
      prompts: [
        {
          raw: 'Prompt 1',
          label: 'prompt1',
        },
        {
          raw: 'Prompt 2',
          label: 'prompt2',
        },
      ],
      providerPromptMap: {
        'Labeled Provider': ['prompt1'],
        'unlabeled-provider-id': ['prompt2'],
      },
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();
    expect(summary).toMatchObject({
      stats: expect.objectContaining({
        successes: 2,
        failures: 0,
      }),
      results: [
        expect.objectContaining({
          provider: expect.objectContaining({
            id: 'labeled-provider-id',
            label: 'Labeled Provider',
          }),
          response: expect.objectContaining({
            output: 'Labeled Provider Output',
          }),
        }),
        expect.objectContaining({
          provider: expect.objectContaining({
            id: 'unlabeled-provider-id',
            label: undefined,
          }),
          response: expect.objectContaining({
            output: 'Unlabeled Provider Output',
          }),
        }),
      ],
    });
    expect(evalRecord.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'Labeled Provider',
        }),
        expect.objectContaining({
          provider: 'unlabeled-provider-id',
        }),
      ]),
    );

    expect(mockLabeledProvider.callApi).toHaveBeenCalledTimes(1);
    expect(mockUnlabeledProvider.callApi).toHaveBeenCalledTimes(1);
  });

  it('should use the options from the test if they exist', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          vars: { var1: 'value1', var2: 'value2' },
          options: {
            transform: 'output + " postprocessed"',
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Test output postprocessed');
  });

  it('evaluate with multiple transforms', async () => {
    const mockApiProviderWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-transform'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Original output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0 },
      }),
      transform: '`Provider: ${output}`',
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithTransform],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Test: Provider: Original output',
            },
          ],
          options: {
            transform: '`Test: ${output}`',
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProviderWithTransform.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].response?.output).toBe('Test: Provider: Original output');
  });

  it('evaluate with provider transform and test postprocess (deprecated)', async () => {
    const mockApiProviderWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-transform'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Original output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
      transform: '`Provider: ${output}`',
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithTransform],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Postprocess: Provider: Original output',
            },
          ],
          options: {
            postprocess: '`Postprocess: ${output}`',
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();
    expect(summary).toMatchObject({
      stats: expect.objectContaining({
        successes: 1,
        failures: 0,
      }),
    });
    expect(summary.results[0].response?.output).toBe('Postprocess: Provider: Original output');

    expect(mockApiProviderWithTransform.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluate with provider transform, test transform, and test postprocess (deprecated)', async () => {
    const mockApiProviderWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-transform'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Original output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
      transform: '`Provider: ${output}`',
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithTransform],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assert: [
            {
              type: 'equals',
              value: 'Transform: Provider: Original output',
            },
          ],
          options: {
            transform: '`Transform: ${output}`',
            postprocess: '`Postprocess: ${output}`', // This should be ignored
          },
        },
      ],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();
    expect(summary).toMatchObject({
      stats: expect.objectContaining({
        successes: 1,
        failures: 0,
      }),
      results: expect.arrayContaining([
        expect.objectContaining({
          response: expect.objectContaining({
            output: 'Transform: Provider: Original output',
          }),
        }),
      ]),
    });
    expect(mockApiProviderWithTransform.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluate with no output', async () => {
    const mockApiProviderNoOutput: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-no-output'),
      callApi: jest.fn().mockResolvedValue({
        output: null,
        tokenUsage: { total: 5, prompt: 5, completion: 0, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderNoOutput],
      prompts: [toPrompt('Test prompt')],
      tests: [],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.stats.successes).toBe(0);
    expect(summary.stats.failures).toBe(1);
    expect(summary.results[0].error).toBe('No output');
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].score).toBe(0);
    expect(mockApiProviderNoOutput.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluate with false output', async () => {
    const mockApiProviderNoOutput: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-no-output'),
      callApi: jest.fn().mockResolvedValue({
        output: false,
        tokenUsage: { total: 5, prompt: 5, completion: 0, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderNoOutput],
      prompts: [toPrompt('Test prompt')],
      tests: [],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].success).toBe(true);
    expect(summary.results[0].score).toBe(1);
    expect(mockApiProviderNoOutput.callApi).toHaveBeenCalledTimes(1);
  });

  it('should apply prompt config to provider call', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test response',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [
        {
          raw: 'You are a helpful math tutor. Solve {{problem}}',
          label: 'Math problem',
          config: {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'math_response',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    final_answer: { type: 'string' },
                  },
                  required: ['final_answer'],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      ],
      tests: [{ vars: { problem: '8x + 31 = 2' } }],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(mockApiProvider.callApi).toHaveBeenCalledWith(
      'You are a helpful math tutor. Solve 8x + 31 = 2',
      expect.objectContaining({
        prompt: expect.objectContaining({
          config: {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'math_response',
                schema: {
                  type: 'object',
                  properties: { final_answer: { type: 'string' } },
                  required: ['final_answer'],
                  additionalProperties: false,
                },
                strict: true,
              },
            },
          },
        }),
      }),
      undefined,
    );
  });

  it('should call runExtensionHook with correct parameters at appropriate times', async () => {
    const mockExtension = 'file:./path/to/extension.js:extensionFunction';
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ var1 }}')],
      tests: [
        {
          vars: { var1: 'value1' },
          assert: [{ type: 'equals', value: 'Test output' }],
        },
      ],
      extensions: [mockExtension],
    };

    const mockedRunExtensionHook = jest.mocked(runExtensionHook);
    mockedRunExtensionHook.mockClear();
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});

    // Check if runExtensionHook was called 4 times (beforeAll, beforeEach, afterEach, afterAll)
    expect(mockedRunExtensionHook).toHaveBeenCalledTimes(4);
    // Check beforeAll call
    expect(mockedRunExtensionHook).toHaveBeenNthCalledWith(
      1,
      [mockExtension],
      'beforeAll',
      expect.objectContaining({ suite: testSuite }),
    );

    // Check beforeEach call
    expect(mockedRunExtensionHook).toHaveBeenNthCalledWith(
      2,
      [mockExtension],
      'beforeEach',
      expect.objectContaining({
        test: expect.objectContaining({
          vars: { var1: 'value1' },
          assert: [{ type: 'equals', value: 'Test output' }],
        }),
      }),
    );

    // Check afterEach call
    expect(mockedRunExtensionHook).toHaveBeenNthCalledWith(
      3,
      [mockExtension],
      'afterEach',
      expect.objectContaining({
        test: expect.objectContaining({
          vars: { var1: 'value1' },
          assert: [{ type: 'equals', value: 'Test output' }],
        }),
        result: expect.objectContaining({
          success: true,
          score: 1,
          response: expect.objectContaining({
            output: 'Test output',
          }),
        }),
      }),
    );

    // Check afterAll call
    expect(mockedRunExtensionHook).toHaveBeenNthCalledWith(
      4,
      [mockExtension],
      'afterAll',
      expect.objectContaining({
        prompts: expect.arrayContaining([
          expect.objectContaining({
            raw: 'Test prompt {{ var1 }}',
            metrics: expect.objectContaining({
              assertPassCount: 1,
              assertFailCount: 0,
            }),
          }),
          expect.objectContaining({
            raw: 'Test prompt {{ var1 }}',
            metrics: expect.objectContaining({
              assertPassCount: 1,
              assertFailCount: 0,
            }),
          }),
        ]),
        results: expect.any(Array),
        suite: testSuite,
      }),
    );
  });

  it('should handle multiple providers', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider, mockApiProvider2],
      prompts: [toPrompt('Test prompt')],
      tests: [],
    };
    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.stats.successes).toBe(2);
    expect(summary.stats.failures).toBe(0);
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(mockApiProvider2.callApi).toHaveBeenCalledTimes(1);
  });

  it('merges defaultTest.vars before applying transformVars', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt {{ test1 }} {{ test2 }} {{ test2UpperCase }}')],
      defaultTest: {
        vars: {
          test2: 'bar',
        },
        options: {
          transformVars: `
            return {
              ...vars,
              test2UpperCase: vars.test2.toUpperCase()
            };
          `,
        },
      },
      tests: [
        {
          vars: {
            test1: 'foo',
          },
        },
      ],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);

    // Check that vars were merged correctly and transform was applied
    expect(summary.results[0].vars).toEqual({
      test1: 'foo',
      test2: 'bar',
      test2UpperCase: 'BAR',
    });

    // Verify the prompt was rendered with all variables
    expect(summary.results[0].prompt.raw).toBe('Test prompt foo bar BAR');
  });

  it('should maintain separate conversation histories based on metadata.conversationId', async () => {
    const mockApiProvider = {
      id: () => 'test-provider',
      callApi: jest.fn().mockImplementation((prompt) => ({
        output: 'Test output',
      })),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [
        {
          raw: '{% for completion in _conversation %}User: {{ completion.input }}\nAssistant: {{ completion.output }}\n{% endfor %}User: {{ question }}',
          label: 'Conversation test',
        },
      ],
      tests: [
        // First conversation
        {
          vars: { question: 'Question 1A' },
          metadata: { conversationId: 'conversation1' },
        },
        {
          vars: { question: 'Question 1B' },
          metadata: { conversationId: 'conversation1' },
        },
        // Second conversation
        {
          vars: { question: 'Question 2A' },
          metadata: { conversationId: 'conversation2' },
        },
        {
          vars: { question: 'Question 2B' },
          metadata: { conversationId: 'conversation2' },
        },
      ],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});

    // Check that the API was called with the correct prompts
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(4);

    // First conversation, first question
    expect(mockApiProvider.callApi).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('User: Question 1A'),
      expect.anything(),
      undefined,
    );

    // First conversation, second question (should include history)
    expect(mockApiProvider.callApi).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('User: Question 1A\nAssistant: Test output\nUser: Question 1B'),
      expect.anything(),
      undefined,
    );

    // Second conversation, first question (should NOT include first conversation)
    expect(mockApiProvider.callApi).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('User: Question 2A'),
      expect.anything(),
      undefined,
    );

    // Second conversation, second question (should only include second conversation history)
    expect(mockApiProvider.callApi).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('User: Question 2A\nAssistant: Test output\nUser: Question 2B'),
      expect.anything(),
      undefined,
    );
  });

  it('evaluates with provider delay', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      delay: 100,
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [{}],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});

    expect(sleep).toHaveBeenCalledWith(100);
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
  });

  it('evaluates with no provider delay', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [{}],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});

    expect(mockApiProvider.delay).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
  });

  it('skips delay for cached responses', async () => {
    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      delay: 100,
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
        cached: true,
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [{}],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});

    expect(sleep).not.toHaveBeenCalled();
    expect(mockApiProvider.callApi).toHaveBeenCalledTimes(1);
  });

  it('handles circular references when logging errors during result saving', async () => {
    // Create a circular reference object that would cause JSON.stringify to fail
    type CircularType = { prop: string; self?: CircularType };
    const circularObj: CircularType = { prop: 'value' };
    circularObj.self = circularObj;

    const mockApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Test output',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
    };

    // Mock Eval.prototype.addResult to throw an error
    const mockAddResult = jest.fn().mockRejectedValue(new Error('Mock save error'));
    const originalAddResult = Eval.prototype.addResult;
    Eval.prototype.addResult = mockAddResult;

    // Create a test suite that will generate a result with a circular reference
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          vars: { circular: circularObj },
        },
      ],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    const errorSpy = jest.spyOn(logger, 'error');
    await evaluate(testSuite, evalRecord, {});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error saving result: Error: Mock save error'),
    );
    Eval.prototype.addResult = originalAddResult;
    errorSpy.mockRestore();
  });

  it('evaluate with assertScoringFunction', async () => {
    const testSuite: TestSuite = {
      providers: [mockApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [
        {
          assertScoringFunction: 'file://path/to/scoring.js:customScore',
          assert: [
            {
              type: 'equals',
              value: 'Test output',
              metric: 'accuracy',
            },
            {
              type: 'contains',
              value: 'output',
              metric: 'relevance',
            },
          ],
        },
      ],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results[0].score).toBe(0.75);
  });

  it('evaluate with provider error response', async () => {
    const mockApiProviderWithError: ApiProvider = {
      id: jest.fn().mockReturnValue('test-provider-error'),
      callApi: jest.fn().mockResolvedValue({
        output: 'Some output',
        error: 'API error occurred',
        tokenUsage: { total: 5, prompt: 5, completion: 0, cached: 0, numRequests: 1 },
      }),
    };

    const testSuite: TestSuite = {
      providers: [mockApiProviderWithError],
      prompts: [toPrompt('Test prompt')],
      tests: [],
    };

    const evalRecord = await Eval.create({}, testSuite.prompts, { id: randomUUID() });
    await evaluate(testSuite, evalRecord, {});
    const summary = await evalRecord.toEvaluateSummary();

    expect(summary).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({
          successes: 0,
          errors: 1,
          failures: 0,
        }),
        results: expect.arrayContaining([
          expect.objectContaining({
            error: 'API error occurred',
            failureReason: ResultFailureReason.ERROR,
            success: false,
            score: 0,
          }),
        ]),
      }),
    );
    expect(mockApiProviderWithError.callApi).toHaveBeenCalledTimes(1);
  });

  it('should handle evaluation timeout', async () => {
    const mockAddResult = jest.fn().mockResolvedValue(undefined);
    let longTimer: NodeJS.Timeout | null = null;

    const slowApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('slow-provider'),
      callApi: jest.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          longTimer = setTimeout(() => {
            resolve({
              output: 'Slow response',
              tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
            });
          }, 5000);
        });
      }),
      cleanup: jest.fn(),
    };

    const mockEval = {
      id: 'mock-eval-id',
      results: [],
      prompts: [],
      persisted: false,
      config: {},
      addResult: mockAddResult,
      addPrompts: jest.fn().mockResolvedValue(undefined),
      fetchResultsByTestIdx: jest.fn().mockResolvedValue([]),
      getResults: jest.fn().mockResolvedValue([]),
      toEvaluateSummary: jest.fn().mockResolvedValue({
        results: [],
        prompts: [],
        stats: {
          successes: 0,
          failures: 0,
          errors: 1,
          tokenUsage: newTokenUsage(),
        },
      }),
      save: jest.fn().mockResolvedValue(undefined),
      setVars: jest.fn().mockResolvedValue(undefined),
    };

    const testSuite: TestSuite = {
      providers: [slowApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [{}],
    };

    try {
      const evalPromise = evaluate(testSuite, mockEval as unknown as Eval, { timeoutMs: 100 });
      await evalPromise;

      expect(slowApiProvider.callApi).toHaveBeenCalledWith(
        'Test prompt',
        expect.anything(),
        expect.objectContaining({
          abortSignal: expect.any(AbortSignal),
        }),
      );

      expect(mockAddResult).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Evaluation timed out after 100ms'),
          success: false,
          failureReason: ResultFailureReason.ERROR,
        }),
      );

      expect(slowApiProvider.cleanup).toHaveBeenCalledWith();
    } finally {
      if (longTimer) {
        clearTimeout(longTimer);
      }
    }
  });

  it('should abort when exceeding maxEvalTimeMs', async () => {
    const mockAddResult = jest.fn().mockResolvedValue(undefined);
    let longTimer: NodeJS.Timeout | null = null;

    const slowApiProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('slow-provider'),
      callApi: jest.fn().mockImplementation((_, __, opts) => {
        return new Promise((resolve, reject) => {
          longTimer = setTimeout(() => {
            resolve({
              output: 'Slow response',
              tokenUsage: { total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 1 },
            });
          }, 1000);

          opts?.abortSignal?.addEventListener('abort', () => {
            if (longTimer) {
              clearTimeout(longTimer);
            }
            reject(new Error('aborted'));
          });
        });
      }),
      cleanup: jest.fn(),
    };

    const mockEval = {
      id: 'mock-eval-id',
      results: [],
      prompts: [],
      persisted: false,
      config: {},
      addResult: mockAddResult,
      addPrompts: jest.fn().mockResolvedValue(undefined),
      fetchResultsByTestIdx: jest.fn().mockResolvedValue([]),
      getResults: jest.fn().mockResolvedValue([]),
      toEvaluateSummary: jest.fn().mockResolvedValue({
        results: [],
        prompts: [],
        stats: {
          successes: 0,
          failures: 0,
          errors: 2,
          tokenUsage: newTokenUsage(),
        },
      }),
      save: jest.fn().mockResolvedValue(undefined),
      setVars: jest.fn().mockResolvedValue(undefined),
    };

    const testSuite: TestSuite = {
      providers: [slowApiProvider],
      prompts: [toPrompt('Test prompt')],
      tests: [{}, {}],
    };

    try {
      const evalPromise = evaluate(testSuite, mockEval as unknown as Eval, { maxEvalTimeMs: 100 });
      await evalPromise;

      expect(mockAddResult).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('aborted'),
          success: false,
          failureReason: ResultFailureReason.ERROR,
        }),
      );
    } finally {
      if (longTimer) {
        clearTimeout(longTimer);
      }
    }
  });

  it('should accumulate token usage correctly', async () => {
    const mockOptions = {
      delay: 0,
      testIdx: 0,
      promptIdx: 0,
      repeatIndex: 0,
      isRedteam: false,
    };

    const results = await runEval({
      ...mockOptions,
      provider: mockApiProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {
        assert: [
          {
            type: 'llm-rubric',
            value: 'Test output',
          },
        ],
        options: { provider: mockGradingApiProviderPasses },
      },
      conversations: {},
      registers: {},
    });

    expect(results[0].tokenUsage).toEqual({
      total: 20, // 10 from provider + 10 from assertion
      prompt: 10, // 5 from provider + 5 from assertion
      completion: 10, // 5 from provider + 5 from assertion
      cached: 0,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      numRequests: 2, // 1 from provider + 1 from assertion
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        completionDetails: {
          reasoning: 0,
          acceptedPrediction: 0,
          rejectedPrediction: 0,
        },
      },
    });
  });
});

describe('generateVarCombinations', () => {
  it('should generate combinations for simple variables', () => {
    const vars = { language: 'English', greeting: 'Hello' };
    const expected = [{ language: 'English', greeting: 'Hello' }];
    expect(generateVarCombinations(vars)).toEqual(expected);
  });

  it('should generate combinations for array variables', () => {
    const vars = { language: ['English', 'French'], greeting: 'Hello' };
    const expected = [
      { language: 'English', greeting: 'Hello' },
      { language: 'French', greeting: 'Hello' },
    ];
    expect(generateVarCombinations(vars)).toEqual(expected);
  });

  it('should handle file paths and expand them into combinations', () => {
    const vars = { language: 'English', greeting: 'file:///path/to/greetings/*.txt' };
    jest.spyOn(glob, 'globSync').mockReturnValue(['greeting1.txt', 'greeting2.txt']);
    const expected = [
      { language: 'English', greeting: 'file://greeting1.txt' },
      { language: 'English', greeting: 'file://greeting2.txt' },
    ];
    expect(generateVarCombinations(vars)).toEqual(expected);
  });

  it('should correctly handle nested array variables', () => {
    const vars = {
      options: [
        ['opt1', 'opt2'],
        ['opt3', 'opt4'],
      ],
    };
    const expected = [
      {
        options: [
          ['opt1', 'opt2'],
          ['opt3', 'opt4'],
        ],
      },
    ];
    expect(generateVarCombinations(vars)).toEqual(expected);
  });

  it('should return an empty array for empty input', () => {
    const vars = {};
    const expected = [{}];
    expect(generateVarCombinations(vars)).toEqual(expected);
  });
});

describe('isAllowedPrompt', () => {
  const prompt1: Prompt = {
    label: 'prompt1',
    raw: '',
  };
  const prompt2: Prompt = {
    label: 'group1:prompt2',
    raw: '',
  };
  const prompt3: Prompt = {
    label: 'group2:prompt3',
    raw: '',
  };

  it('should return true if allowedPrompts is undefined', () => {
    expect(isAllowedPrompt(prompt1, undefined)).toBe(true);
  });

  it('should return true if allowedPrompts includes the prompt label', () => {
    expect(isAllowedPrompt(prompt1, ['prompt1', 'prompt2'])).toBe(true);
  });

  it('should return true if allowedPrompts includes a label that matches the start of the prompt label followed by a colon', () => {
    expect(isAllowedPrompt(prompt2, ['group1'])).toBe(true);
  });

  it('should return false if allowedPrompts does not include the prompt label or any matching start label with a colon', () => {
    expect(isAllowedPrompt(prompt3, ['group1', 'prompt2'])).toBe(false);
  });

  it('should return false if allowedPrompts is an empty array', () => {
    expect(isAllowedPrompt(prompt1, [])).toBe(false);
  });
});

describe('runEval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockProvider: ApiProvider = {
    id: jest.fn().mockReturnValue('test-provider'),
    callApi: jest.fn().mockResolvedValue({
      output: 'Test output',
      tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
    }),
  };

  const defaultOptions = {
    delay: 0,
    testIdx: 0,
    promptIdx: 0,
    repeatIndex: 0,
    isRedteam: false,
  };

  it('should handle basic prompt evaluation', async () => {
    const results = await runEval({
      ...defaultOptions,
      provider: mockProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {},
      conversations: {},
      registers: {},
    });
    const result = results[0];
    expect(result.success).toBe(true);
    expect(result.response?.output).toBe('Test output');
    expect(result.prompt.label).toBe('test-label');
    expect(mockProvider.callApi).toHaveBeenCalledWith('Test prompt', expect.anything(), undefined);
  });

  it('should handle conversation history', async () => {
    const conversations = {} as Record<string, any>;

    const results = await runEval({
      ...defaultOptions,
      provider: mockProvider,
      prompt: { raw: 'Hello {{_conversation[0].output}}', label: 'test-label' },
      test: {},
      conversations,
      registers: {},
    });
    const result = results[0];
    expect(result.success).toBe(true);
    expect(conversations).toHaveProperty('test-provider:undefined');
    expect(conversations['test-provider:undefined']).toHaveLength(1);
    expect(conversations['test-provider:undefined'][0]).toEqual({
      prompt: 'Hello ',
      input: 'Hello ',
      output: 'Test output',
    });
  });

  it('should handle conversation with custom ID', async () => {
    const conversations = {};

    const results = await runEval({
      ...defaultOptions,
      provider: mockProvider,
      prompt: { raw: 'Hello {{_conversation[0].output}}', label: 'test-label', id: 'custom-id' },
      test: { metadata: { conversationId: 'conv1' } },
      conversations,
      registers: {},
    });
    const result = results[0];
    expect(result.success).toBe(true);
    expect(conversations).toHaveProperty('test-provider:custom-id:conv1');
  });

  it('should handle registers', async () => {
    const registers = { savedValue: 'stored data' };

    const results = await runEval({
      ...defaultOptions,
      provider: mockProvider,
      prompt: { raw: 'Using {{savedValue}}', label: 'test-label' },
      test: {},
      conversations: {},
      registers,
    });
    const result = results[0];
    expect(result.success).toBe(true);
    expect(mockProvider.callApi).toHaveBeenCalledWith(
      'Using stored data',
      expect.anything(),
      undefined,
    );
  });

  it('should store output in register when specified', async () => {
    const registers = {};

    const results = await runEval({
      ...defaultOptions,
      provider: mockProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: { options: { storeOutputAs: 'myOutput' } },
      conversations: {},
      registers,
    });
    const result = results[0];
    expect(result.success).toBe(true);
    expect(registers).toHaveProperty('myOutput', 'Test output');
  });

  it('should handle provider errors', async () => {
    const errorProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('error-provider'),
      callApi: jest.fn().mockRejectedValue(new Error('API Error')),
    };

    // Define defaultOptions locally for this test
    const defaultOptions = {
      delay: 0,
      testIdx: 0,
      promptIdx: 0,
      repeatIndex: 0,
      isRedteam: false,
    };

    const results = await runEval({
      ...defaultOptions,
      provider: errorProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {},
      conversations: {},
      registers: {},
    });
    const result = results[0];
    expect(result.success).toBe(false);
    expect(result.error).toContain('API Error');
    expect(result.failureReason).toBe(ResultFailureReason.ERROR);
  });

  it('should handle null output differently for red team tests', async () => {
    const nullOutputProvider: ApiProvider = {
      id: jest.fn().mockReturnValue('null-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: null,
        tokenUsage: { total: 5, prompt: 5, completion: 0, cached: 0, numRequests: 1 },
      }),
    };

    // Regular test
    const regularResults = await runEval({
      ...defaultOptions,
      provider: nullOutputProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {},
      conversations: {},
      registers: {},
      isRedteam: false,
    });

    expect(regularResults[0].success).toBe(false);
    expect(regularResults[0].error).toBe('No output');

    // Red team test
    const redTeamResults = await runEval({
      ...defaultOptions,
      provider: nullOutputProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {},
      conversations: {},
      registers: {},
      isRedteam: true,
    });

    expect(redTeamResults[0].success).toBe(true);
    expect(redTeamResults[0].error).toBeUndefined();
  });

  it('should apply transforms in correct order', async () => {
    const providerWithTransform: ApiProvider = {
      id: jest.fn().mockReturnValue('transform-provider'),
      callApi: jest.fn().mockResolvedValue({
        output: 'original',
        tokenUsage: { total: 10, prompt: 5, completion: 5, cached: 0, numRequests: 1 },
      }),
      transform: 'output + "-provider"',
    };

    const results = await runEval({
      ...defaultOptions,
      provider: providerWithTransform,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {
        options: { transform: 'output + "-test"' },
      },
      conversations: {},
      registers: {},
    });

    expect(results[0].success).toBe(true);
    expect(results[0].response?.output).toBe('original-provider-test');
  });

  it('should accumulate token usage correctly', async () => {
    const results = await runEval({
      ...defaultOptions,

      provider: mockProvider,
      prompt: { raw: 'Test prompt', label: 'test-label' },
      test: {
        assert: [
          {
            type: 'llm-rubric',
            value: 'Test output',
          },
        ],
        options: { provider: mockGradingApiProviderPasses },
      },
      conversations: {},
      registers: {},
    });

    expect(results[0].tokenUsage).toEqual({
      total: 20, // 10 from provider + 10 from assertion
      prompt: 10, // 5 from provider + 5 from assertion
      completion: 10, // 5 from provider + 5 from assertion
      cached: 0,
      completionDetails: {
        reasoning: 0,
        acceptedPrediction: 0,
        rejectedPrediction: 0,
      },
      numRequests: 2, // 1 from provider + 1 from assertion
      assertions: {
        total: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        completionDetails: {
          reasoning: 0,
          acceptedPrediction: 0,
          rejectedPrediction: 0,
        },
      },
    });
  });
});

describe('calculateThreadsPerBar', () => {
  it('should evenly distribute threads when concurrency is a multiple of numProgressBars', () => {
    // 10 threads, 5 progress bars = 2 threads per bar
    expect(calculateThreadsPerBar(10, 5, 0)).toBe(2);
    expect(calculateThreadsPerBar(10, 5, 1)).toBe(2);
    expect(calculateThreadsPerBar(10, 5, 4)).toBe(2);

    // 12 threads, 6 progress bars = 2 threads per bar
    expect(calculateThreadsPerBar(12, 6, 0)).toBe(2);
    expect(calculateThreadsPerBar(12, 6, 5)).toBe(2);
  });

  it('should correctly distribute extra threads for the first N bars', () => {
    // 11 threads, 5 progress bars = 2 threads for first bar, 2 for the rest
    // floor(11/5) = 2 with 1 extra thread
    expect(calculateThreadsPerBar(11, 5, 0)).toBe(3); // First bar gets 2+1
    expect(calculateThreadsPerBar(11, 5, 1)).toBe(2);
    expect(calculateThreadsPerBar(11, 5, 4)).toBe(2);

    // 17 threads, 6 progress bars = 2 threads for first 5 bars, 2 for the last
    // floor(17/6) = 2 with 5 extra threads
    expect(calculateThreadsPerBar(17, 6, 0)).toBe(3); // First bar gets 2+1
    expect(calculateThreadsPerBar(17, 6, 4)).toBe(3); // Fifth bar gets 2+1
    expect(calculateThreadsPerBar(17, 6, 5)).toBe(2); // Last bar gets just 2
  });

  it('should handle edge cases', () => {
    // 1 thread, 1 progress bar
    expect(calculateThreadsPerBar(1, 1, 0)).toBe(1);

    // More progress bars than threads (1 thread per bar until we run out)
    expect(calculateThreadsPerBar(3, 5, 0)).toBe(1);
    expect(calculateThreadsPerBar(3, 5, 1)).toBe(1);
    expect(calculateThreadsPerBar(3, 5, 2)).toBe(1);
    expect(calculateThreadsPerBar(3, 5, 3)).toBe(0);
    expect(calculateThreadsPerBar(3, 5, 4)).toBe(0);

    // Large numbers
    expect(calculateThreadsPerBar(101, 20, 0)).toBe(6); // 5 with 1 extra
    expect(calculateThreadsPerBar(101, 20, 19)).toBe(5); // Last bar gets no extra
  });
});
