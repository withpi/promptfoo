import { themes } from 'prism-react-renderer';
import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import type { ConfigureWebpackResult } from '@docusaurus/types/src/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeMarkdown } from './src/utils/markdown';

const lightCodeTheme = themes.github;
const darkCodeTheme = themes.duotoneDark;

const config: Config = {
  title: 'promptfoo',
  tagline: 'Test your prompts',
  favicon: '/favicon.ico',

  // Set the production url of your site here
  url: 'https://www.promptfoo.dev',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  trailingSlash: true,

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'promptfoo', // Usually your GitHub org/user name.
  projectName: 'promptfoo', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'throw',
  onBrokenAnchors: 'throw',
  // Even if you don't use internalization, you can use this field to set useful
  // metadata like html lang. For example, if your site is Chinese, you may want
  // to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com',
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossorigin: 'true',
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap',
      },
    },
  ],

  scripts: [
    {
      src: '/js/scripts.js',
      async: true,
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/promptfoo/promptfoo/tree/main/site',
          sidebarCollapsed: false,
        },
        blog: {
          showReadingTime: false,
          blogSidebarCount: 0,
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          //editUrl:
          //  'https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
        gtag:
          process.env.NODE_ENV === 'development'
            ? undefined
            : {
                trackingID: 'G-3TS8QLZQ93',
                anonymizeIP: true,
              },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/thumbnail.png',
    navbar: {
      title: 'promptfoo',
      logo: {
        alt: 'promptfoo logo',
        src: 'img/logo-panda.svg',
      },
      items: [
        {
          type: 'dropdown',
          label: 'Products',
          position: 'left',
          items: [
            {
              to: '/red-teaming/',
              label: 'Red Teaming',
            },
            {
              to: '/guardrails/',
              label: 'Guardrails',
            },
            {
              to: '/model-security/',
              label: 'Model Security',
            },
            {
              to: '/docs/getting-started/',
              label: 'Evaluations',
            },
          ],
        },
        {
          type: 'dropdown',
          label: 'Company',
          position: 'left',
          items: [
            {
              href: '/about/',
              label: 'About',
            },
            {
              href: '/blog/',
              label: 'Blog',
            },
            {
              href: '/press/',
              label: 'Press',
            },
            {
              href: '/contact/',
              label: 'Contact',
            },
            {
              href: '/careers/',
              label: 'Careers',
            },
          ],
        },
        {
          type: 'dropdown',
          label: 'Resources',
          position: 'left',
          items: [
            {
              href: '/docs/intro/',
              label: 'Docs',
            },
            {
              to: 'https://www.promptfoo.dev/docs/api-reference/',
              label: 'API Reference',
            },
            {
              to: 'https://www.promptfoo.dev/models/',
              label: 'Foundation Model Reports',
            },
            {
              to: 'https://www.promptfoo.dev/lm-security-db/',
              label: 'Language Model Security DB',
            },
            {
              href: 'https://github.com/promptfoo/promptfoo',
              label: 'GitHub',
            },
            {
              href: 'https://discord.gg/promptfoo',
              label: 'Discord',
            },
          ],
        },
        { to: '/pricing/', label: 'Enterprise', position: 'left' },
        {
          to: 'https://promptfoo.app',
          position: 'right',
          'aria-label': 'Promptfoo App',
          label: 'Log in',
        },
        {
          href: 'https://github.com/promptfoo/promptfoo',
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
        {
          href: 'https://discord.gg/promptfoo',
          position: 'right',
          className: 'header-discord-link',
          'aria-label': 'Discord community',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Product',
          items: [
            {
              label: 'Red Teaming',
              to: '/red-teaming/',
            },
            {
              label: 'Guardrails',
              to: '/guardrails/',
            },
            {
              label: 'Model Security',
              to: '/model-security/',
            },
            {
              label: 'Evaluations',
              to: '/docs/getting-started/',
            },
            {
              label: 'Enterprise',
              href: '/pricing/',
            },
            {
              label: 'Status',
              href: 'https://status.promptfoo.dev',
            },
          ],
        },
        {
          title: 'Resources',
          items: [
            {
              label: 'LLM Red Teaming',
              to: '/docs/red-team',
            },
            {
              label: 'Foundation Model Reports',
              to: 'https://www.promptfoo.dev/models/',
            },
            {
              label: 'Language Model Security DB',
              to: 'https://www.promptfoo.dev/lm-security-db/',
            },
            {
              label: 'Running Benchmarks',
              to: '/docs/guides/llama2-uncensored-benchmark-ollama',
            },
            {
              label: 'Evaluating Factuality',
              to: '/docs/guides/factuality-eval',
            },
            {
              label: 'Evaluating RAGs',
              to: '/docs/guides/evaluate-rag',
            },
            {
              label: 'Minimizing Hallucinations',
              to: '/docs/guides/prevent-llm-hallucations',
            },
            {
              label: 'Config Validator',
              to: '/validator',
            },
          ],
        },
        {
          title: 'Company',
          items: [
            {
              label: 'About',
              to: '/about/',
            },
            {
              label: 'Blog',
              to: '/blog/',
            },
            {
              label: 'Press',
              to: '/press/',
            },
            {
              label: 'Contact',
              to: '/contact/',
            },
            {
              label: 'Careers',
              to: '/careers/',
            },
            {
              label: 'Log in',
              to: 'https://promptfoo.app',
            },
          ],
        },
        {
          title: 'Legal & Social',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/promptfoo/promptfoo',
            },
            {
              label: 'Discord',
              href: 'https://discord.gg/promptfoo',
            },
            {
              label: 'LinkedIn',
              href: 'https://www.linkedin.com/company/promptfoo/',
            },
            {
              label: 'Privacy Policy',
              to: '/privacy/',
            },
            {
              label: 'Terms of Service',
              to: '/terms-of-service/',
            },
            {
              label: 'Trust Center',
              href: 'https://trust.promptfoo.dev',
            },
            {
              html: `
                <div style="display: flex; gap: 16px; align-items: center; margin-top: 12px;">
                  <!--
                  <div style="position: relative;">
                    <span style="position: absolute; left: 65px; top: 25px; font-size: 10px; font-weight: bold; background-color: #25842c; padding: 2px 4px; border-radius: 4px;">In Progress</span>
                    <img loading="lazy" src="/img/badges/soc2.png" alt="SOC2 Compliance in progress" style="width:80px; height: auto"/>
                  </div>
                  -->
                  <img loading="lazy" src="/img/badges/iso27001.png" alt="ISO 27001 Certified" style="width:90px; height: auto"/>
                </div>
                `,
            },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} promptfoo`,
    },
    prism: {
      theme: lightCodeTheme,
      darkTheme: darkCodeTheme,
      additionalLanguages: [
        'bash',
        'javascript',
        'typescript',
        'python',
        'json',
        'yaml',
        'markup-templating',
        'liquid',
      ],
    },
    zoom: {
      selector: '.markdown :not(em) > img:not(.no-zoom)',
    },
    algolia: {
      // The application ID provided by Algolia
      appId: 'VPUDC1V4TA',

      // Public API key: it is safe to commit it
      apiKey: '0b4fcfd05976eb0aaf4b7c51ec4fcd23',

      indexName: 'promptfoo',
    },
  } satisfies Preset.ThemeConfig,

  plugins: [
    require.resolve('docusaurus-plugin-image-zoom'),
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/docs/category/troubleshooting',
            to: '/docs/usage/troubleshooting',
          },
          {
            from: '/docs/providers/palm',
            to: '/docs/providers/google',
          },
          {
            from: '/docs',
            to: '/docs/intro',
          },
        ],
      },
    ],
    // Plugin to serve markdown files for CopyPageButton
    function markdownServePlugin(context) {
      return {
        name: 'markdown-serve-plugin',
        loadContent: async () => {
          const { siteDir } = context;
          const docsDir = path.join(siteDir, 'docs');
          const mdFiles: { [path: string]: string } = {};

          // Recursive function to get all mdx/md files with their paths
          const getMdFiles = async (dir: string, basePath: string = ''): Promise<void> => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relativePath = path.join(basePath, entry.name);

              if (entry.isDirectory()) {
                await getMdFiles(fullPath, relativePath);
              } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
                let content = await fs.promises.readFile(fullPath, 'utf8');

                // Remove frontmatter (content between --- delimiters)
                content = content.replace(/^---[\s\S]*?---\s*/m, '');

                // If this is an index.md file, also store it with the directory path
                // to make it accessible via the directory URL
                if (entry.name === 'index.md' || entry.name === 'index.mdx') {
                  if (basePath) {
                    mdFiles[`${basePath}.md`] = content;
                  }
                } else {
                  // Store the file using its relativePath
                  mdFiles[relativePath] = content;
                }
              }
            }
          };

          await getMdFiles(docsDir);
          return { mdFiles };
        },

        // Configure webpack for dev server middleware
        configureWebpack(config, isServer) {
          if (isServer) {
            return {};
          }

          // This is our fallback approach in case extendDevServer doesn't work
          const { siteDir } = context;
          const docsDir = path.join(siteDir, 'docs');

          return {
            devServer: {
              setupMiddlewares: (middlewares, devServer) => {
                if (!devServer) {
                  throw new Error('webpack-dev-server is not defined');
                }

                devServer.app.get('/markdown/*', async (req, res) => {
                  const requestPath = req.path.replace(/^\/markdown\//, '');

                  // Try both with and without file extension
                  let filePath = path.join(docsDir, requestPath);
                  let foundFile = false;

                  // Try direct match first
                  try {
                    const stat = await fs.promises.stat(filePath);
                    if (stat.isFile()) {
                      foundFile = true;
                    }
                  } catch (err) {
                    // File doesn't exist, try with extensions
                    const extensions = ['.md', '.mdx'];
                    for (const ext of extensions) {
                      try {
                        const filePathWithExt = `${filePath}${ext}`;
                        const stat = await fs.promises.stat(filePathWithExt);
                        if (stat.isFile()) {
                          filePath = filePathWithExt;
                          foundFile = true;
                          break;
                        }
                      } catch (err) {
                        // Try index.md in the directory
                        try {
                          const indexPath = path.join(filePath.split('.')[0], `index${ext}`);
                          const stat = await fs.promises.stat(indexPath);
                          if (stat.isFile()) {
                            filePath = indexPath;
                            foundFile = true;
                            break;
                          }
                        } catch (indexErr) {
                          // Ignore errors for index files
                        }
                      }
                    }
                  }

                  if (foundFile) {
                    try {
                      // Read the file directly from the filesystem
                      const content = sanitizeMarkdown(
                        await fs.promises.readFile(filePath, 'utf8'),
                      );

                      // Set appropriate headers for raw markdown content
                      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
                      res.setHeader('Cache-Control', 'no-cache');
                      res.setHeader('X-Content-Type-Options', 'nosniff');
                      res.send(content);
                    } catch (error) {
                      res.status(500).send('Error reading markdown file');
                    }
                  } else {
                    res.status(404).send('Markdown file not found');
                  }
                });

                return middlewares;
              },
            },
          } as ConfigureWebpackResult;
        },

        // Build process - generate static files for production
        async postBuild({ content, outDir }) {
          // Type assertion to handle TypeScript type checking
          const pluginContent = content as { mdFiles: { [path: string]: string } };
          const { mdFiles } = pluginContent;

          // Create directory for markdown files
          const mdOutDir = path.join(outDir, 'markdown');
          try {
            await fs.promises.mkdir(mdOutDir, { recursive: true });
          } catch (err) {
            console.error('Error creating markdown directory:', err);
            throw err;
          }

          // Write each markdown file to the output directory
          for (const [filePath, content] of Object.entries(mdFiles)) {
            const outPath = path.join(mdOutDir, filePath);
            const outDirname = path.dirname(outPath);

            try {
              // Create nested directories if needed
              await fs.promises.mkdir(outDirname, { recursive: true });
              const sanitized = sanitizeMarkdown(content);
              await fs.promises.writeFile(outPath, sanitized);
            } catch (err) {
              console.error(`Error writing markdown file ${filePath}:`, err);
            }
          }
        },
      };
    },
    // Define the llms.txt plugin inline similar to the Prisma example
    async function llmsTxtPlugin(context) {
      return {
        name: 'llms-txt-plugin',
        loadContent: async () => {
          const { siteDir } = context;
          const docsDir = path.join(siteDir, 'docs');
          const allMdx: string[] = [];

          // Recursive function to get all mdx/md files
          const getMdFiles = async (dir: string): Promise<void> => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                await getMdFiles(fullPath);
              } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
                const content = await fs.promises.readFile(fullPath, 'utf8');
                allMdx.push(content);
              }
            }
          };

          await getMdFiles(docsDir);
          return { allMdx };
        },
        postBuild: async ({ content, routesPaths, outDir }) => {
          // Type assertion to handle TypeScript type checking
          const pluginContent = content as { allMdx: string[] };
          const { allMdx } = pluginContent;

          // Write concatenated MDX content
          const concatenatedPath = path.join(outDir, 'llms-full.txt');
          await fs.promises.writeFile(concatenatedPath, allMdx.join('\n\n---\n\n'));

          // Process routes - use routesPaths which is a string[] of all routes
          const docsRoutes: string[] = [];

          // Filter for docs paths and generate entries
          for (const routePath of routesPaths) {
            if (routePath.startsWith('/docs/')) {
              // Extract a title from the route path as fallback
              const pathParts = routePath.split('/').filter(Boolean);
              const lastPart = pathParts[pathParts.length - 1];
              const title = lastPart
                .split('-')
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' ');

              docsRoutes.push(`- [${title}](${routePath})`);
            }
          }

          // Build up llms.txt file
          const llmsTxt = `# ${context.siteConfig.title}\n\n## Docs\n\n${docsRoutes.join('\n')}`;

          // Write llms.txt file
          const llmsTxtPath = path.join(outDir, 'llms.txt');
          try {
            fs.writeFileSync(llmsTxtPath, llmsTxt);
            console.log('Successfully created llms.txt and llms-full.txt files.');
          } catch (err) {
            console.error('Error writing llms.txt file:', err);
            throw err;
          }
        },
      };
    },
  ],

  // Mermaid diagram support
  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],
};

export default config;
