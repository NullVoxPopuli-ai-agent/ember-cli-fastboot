import FastBoot from './index.js';
import fastbootMiddleware from './middleware.js';

/**
 * Vite plugin for FastBoot.
 *
 * - `vite` (dev): pages are rendered on the server from the current source files.
 * - `vite build --ssr <entry>`: builds the SSR bundle for `new FastBoot({ entry })`.
 *
 * @param {object} [options]
 * @param {string} [options.entry] the SSR entry module; the default is `app/app-ssr.js`
 * @param {Array<string | RegExp>} [options.allowedHosts] hosts that `fastboot.request.host` accepts
 * @param {number} [options.settledTimeout] milliseconds to wait for the app to settle
 */
export function fastboot(options = {}) {
  let { entry = 'app/app-ssr.js', ...fastbootOptions } = options;
  let command;

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
