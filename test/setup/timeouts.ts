// Timeouts of the test projects (vitest.config.ts, test/setup/dom.ts). They
// are ceilings for slow machines, not waits: a passing test never sleeps them.

// findBy*/waitFor in component tests: long enough for a lazy chunk's first
// transform under load.
export const LAZY_UI_TIMEOUT_MS = 5_000;

// A component test may wait on several lazy chunks in a row.
export const DOM_TEST_TIMEOUT_MS = 15_000;

// Node tests: integration files boot the whole backend (and SSH/FTP harnesses)
// in beforeAll, which a loaded runner can take well over 10 s to transform.
export const NODE_TEST_TIMEOUT_MS = 15_000;
// Hooks of both projects (the contract tests boot the backend from jsdom too).
export const HOOK_TIMEOUT_MS = 30_000;
