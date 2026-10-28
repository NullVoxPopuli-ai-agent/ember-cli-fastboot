import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import FastBoot from './index.js';
import fastbootMiddleware from './middleware.js';
import { prerender } from './prerender.js';

/**
 * Vite plugin for FastBoot.
 *
 * - `vite` (dev): pages are rendered on the server from the current source files.
 * - `vite build --ssr <entry>`: builds the SSR bundle for `new FastBoot({ entry })`.
 * - `vite build` with `prerender`: writes a static page for each route (SSG).
 *
 * @param {object} [options]
 * @param {string} [options.entry] the SSR entry module; the default is `app/app-ssr.js`
 * @param {Array<string | RegExp>} [options.allowedHosts] hosts that `fastboot.request.host` accepts
 * @param {number} [options.settledTimeout] milliseconds to wait for the app to settle
 * @param {object} [options.prerender] the pages to write at build time
 * @param {string[]} options.prerender.routes the URLs of the pages
 * @param {string} [options.prerender.template] the built HTML file to render into; the default is `index.html`
 */
export function fastboot(options = {}) {
  let { entry = 'app/app-ssr.js', prerender: prerenderOptions, ...fastbootOptions } = options;
  let command;
  let resolvedConfig;

  return {
    name: 'fastboot',

    /**
     * The SSR bundle includes every dependency.
     * Node cannot resolve the module names that the Ember build resolves,
     * for example `@ember/application`.
     */
    config(_config, env) {
      command = env.command;

      return { ssr: { noExternal: true } };
    },

    configResolved(config) {
      resolvedConfig = config;
    },

    /**
     * After the client build: build the SSR bundle into a temporary directory,
     * render each route with it, and remove it.
     *
     * The SSR build loads the same config file, and this hook skips it there (`build.ssr` is set).
     */
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        if (!prerenderOptions || command !== 'build' || resolvedConfig.build.ssr) return;

        let config = resolvedConfig;
        let distPath = resolve(config.root, config.build.outDir);
        /** Not in `node_modules`: there, the SSR build leaves app modules unresolved. */
        let serverDir = await mkdtemp(join(tmpdir(), 'fastboot-ssr-'));

        try {
          await buildServer(config, entry, serverDir);

          let pages = await prerender({
            ...fastbootOptions,
            ...prerenderOptions,
            distPath,
            entry: join(serverDir, await entryFile(serverDir, entry)),
          });

          config.logger.info(`fastboot: prerendered ${pages.length} pages`);
        } finally {
          await rm(serverDir, { recursive: true, force: true });
        }
      },
    },

    transform(code, _id, transformOptions) {
      if (command !== 'serve' || !transformOptions?.ssr) return null;

      return wrapCommonJS(code);
    },

    configureServer(server) {
      let handler;

      /**
       * This runs after the internal middlewares of Vite.
       * There, a page request has `req.url` = '/index.html',
       * and `req.originalUrl` is the URL of the page.
       */
      return () => {
        server.middlewares.use((req, res, next) => {
          let path = req.url.split('?')[0];

          if (!path.endsWith('.html') || !req.headers.accept?.includes('text/html')) {
            next();
            return;
          }

          handler ??= fastbootMiddleware(
            new FastBoot({ ...fastbootOptions, vite: server, entry: `/${entry.replace(/^\//, '')}` }),
          );

          handler(req, res, (error) => {
            if (error) server.ssrFixStacktrace(error);

            next(error);
          });
        });
      };
    },
  };
}

/**
 * Runs `vite build --ssr` with the config of the client build.
 */
async function buildServer(config, entry, outDir) {
  let { build } = await import('vite');

  await build({
    ...config.inlineConfig,
    configFile: config.configFile ?? false,
    mode: config.mode,
    logLevel: 'warn',
    build: { ...config.inlineConfig.build, ssr: entry, outDir, emptyOutDir: true },
  });
}

/**
 * The SSR build writes one entry file, named after the entry module.
 */
async function entryFile(outDir, entry) {
  let name = basename(entry).replace(/\.[^.]+$/, '');
  let files = await readdir(outDir);
  let file = files.find((candidate) => candidate === `${name}.mjs` || candidate === `${name}.js`);

  if (!file) throw new Error(`The SSR build wrote no ${name}.mjs or ${name}.js to ${outDir}`);

  return file;
}

/**
 * The dev server evaluates SSR modules as ES modules,
 * where `module` and `exports` do not exist.
 * A CommonJS file in the dependencies gets them from this wrapper.
 *
 * A build does not need it: the bundler converts CommonJS itself.
 */
function wrapCommonJS(code) {
  if (/^(?:import\s|export\s|export\{|export default)/m.test(code)) return null;
  if (!/\bexports\s*[.[=]|\bmodule\s*\.\s*exports\b/.test(code)) return null;

  return {
    code: [
      'const __fastboot_module__ = { exports: {} };',
      '(function (module, exports, global) {',
      code,
      '})(__fastboot_module__, __fastboot_module__.exports, globalThis);',
      'export default __fastboot_module__.exports;',
    ].join('\n'),
    map: null,
  };
}
