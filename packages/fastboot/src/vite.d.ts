import type { Plugin } from 'vite';

import type { AllowedHost } from './index.js';

export interface FastBootPluginOptions {
  /** The SSR entry module. The default is `app/app-ssr.js`. */
  entry?: string;
  allowedHosts?: AllowedHost[];
  settledTimeout?: number;
  redirectCode?: number;
}

export function fastboot(options?: FastBootPluginOptions): Plugin;
