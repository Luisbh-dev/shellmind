// Timeouts of the test projects (vitest.config.ts, test/setup/dom.ts) and of
// the tests that start real processes. They are ceilings for slow machines,
// not waits: a passing test never sleeps them.

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

// A node test that starts real processes and waits for them (a shell and the
// commands of its script, PowerShell, the backend under tsx): its time is
// process creation and disk, which a hosted Windows runner can stall for
// minutes. In the Windows CI run of 1.0.0 the files that started processes or
// wrote to disk from 20:52:13 to 20:56:03 ran 7-260 times slower than in eight
// other runs of the same tests (an install script 1.5 s -> 113 s, the apt
// check 0.55 s -> 106 s). A test caught in such a stall lasts at most the
// stall plus its own time: this outlasts that one (230 s). In a test on this
// budget, a deadline it sets only so that a stuck process does not outlive it
// (a helper's kill, spawnSync's timeout, the backend's ready timeout) is this
// budget too, or it would fail the test first.
export const PROCESS_TEST_TIMEOUT_MS = 240_000;
