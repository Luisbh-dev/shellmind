import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The environment variables that change backend behaviour, derived from the
// backend's sources rather than kept by hand: every `process.env.NAME` the
// non-test files under server/ read, and the AI providers' key variables
// (looked up through their `envKey`). A developer's shell or .env would
// otherwise leak into the tests (SHELLMIND_RESET_DATA_KEY=1 turned the data key
// guard tests red).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read by the backend but describing the machine, not ShellMind: tests and the
// shells they spawn need them.
const SYSTEM_VARS = new Set([
    'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'SHELL', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
    'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
]);

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(file);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
    });
}

let cached: string[] | null = null;

export function backendEnvVars(): string[] {
    if (cached) return cached;
    const names = new Set<string>();
    for (const file of [path.join(root, 'server.ts'), ...sourceFiles(path.join(root, 'server'))]) {
        const source = fs.readFileSync(file, 'utf8');
        for (const [, name] of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(name);
        for (const [, name] of source.matchAll(/envKey:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) names.add(name);
    }
    cached = [...names].filter((name) => !SYSTEM_VARS.has(name.toUpperCase())).sort();
    return cached;
}

// A .env file that does not exist: dotenv (server/config.ts) then loads nothing.
export const NO_DOTENV_FILE = path.join(os.tmpdir(), 'shellmind-test-no-dotenv', 'missing.env');

// Removes every backend variable from process.env and keeps dotenv away from
// the repository's .env. Idempotent: test/setup/node.ts runs it before every
// node test file, bootTestServer() again before it applies its own env.
export function clearBackendEnv(): void {
    for (const name of backendEnvVars()) delete process.env[name];
    process.env.DOTENV_CONFIG_PATH = NO_DOTENV_FILE;
    process.env.DOTENV_CONFIG_QUIET = 'true';
}
