import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The Workers runtime module only exists inside the Workers runtime, so the
      // tests use a stub of it.
      'cloudflare:workers': fileURLToPath(
        new URL('./packages/relay/test/cloudflare-workers-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/**'],
    environment: 'node',
  },
});
