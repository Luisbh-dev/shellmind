import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'
import { DOM_TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, NODE_TEST_TIMEOUT_MS } from './test/setup/timeouts'

// Node is the default environment (server, shared and pure frontend modules).
// React component tests (src/**/*.test.tsx) run in jsdom.
export default defineConfig((configEnv) => mergeConfig(viteConfig(configEnv), defineConfig({
  test: {
    // The persistent transform cache keys modules by their own source, so the
    // expansion of import.meta.glob (locales, workspace tabs, actions) went
    // stale whenever a file was added next to an unchanged registry.
    fsModuleCache: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts', '{server,shared,src}/**/*.test.ts'],
          setupFiles: ['./src/i18n/testSetup.ts', './test/setup/node.ts'],
          testTimeout: NODE_TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'test/**/*.test.tsx'],
          setupFiles: ['./src/i18n/testSetup.ts', './src/lib/testPreload.ts', './test/setup/dom.ts'],
          testTimeout: DOM_TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['server.ts', 'server/**', 'shared/**', 'src/**', 'electron/**', 'scripts/**'],
      exclude: ['**/*.test.{ts,tsx}'],
      // Floors a little under the measured totals (Windows: lines 88, branches
      // 79), so coverage cannot quietly drop. server/lifecycle.ts reads low: it
      // runs in the backend child processes of startup-ipc, whose coverage is
      // not merged (autoAttachSubprocess replaced the worker's coverage of
      // every module the child loaded instead of adding to it).
      thresholds: {
        lines: 85,
        statements: 82,
        functions: 82,
        branches: 76,
      },
      reportsDirectory: 'coverage',
    },
  },
})))
