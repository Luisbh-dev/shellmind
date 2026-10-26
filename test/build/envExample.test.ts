import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backendEnvVars } from '../setup/backendEnv';

// .env.example documents every setting: whatever the backend reads (derived
// from server/), plus what `npm start` and the Vite build read from .env.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const example = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
// `# NAME=` (commented, the default) or `NAME=`.
const documented = (name: string) => [...example.matchAll(new RegExp(`^#? ?${name}=`, 'gm'))].length;

// Set by the tooling (the desktop app), never by hand; named in the header.
const TOOLING = ['SHELLMIND_VERSION', 'SHELLMIND_ALLOW_FILE_ORIGIN'];

describe('.env.example', () => {
    it('documents every variable the backend, `npm start` and the web build read, once', () => {
        const names = [...backendEnvVars().filter((name) => !TOOLING.includes(name)), 'WEB_PORT', 'VITE_API_BASE'];
        expect(names).toEqual(expect.arrayContaining(['MINIMAX_PROXY_API_KEY', 'MINIMAX_PROXY_BEARER_TOKEN', 'SHELLMIND_DEBUG']));
        expect(Object.fromEntries(names.map((name) => [name, documented(name)]))).toEqual(Object.fromEntries(names.map((name) => [name, 1])));
        for (const name of TOOLING) expect(example, name).toContain(name);
    });

    it('does not present a made-up path as the default database location', () => {
        expect(example).not.toContain('DB_PATH=./.data/shellmind.db');
        expect(example).toMatch(/shellmind\.db in the project folder/);
    });
});
