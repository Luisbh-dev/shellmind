import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNLOADABLE } from '../../scripts/check-native.mjs';

// The packaging and install settings in package.json that a packaged smoke
// test (`npm run smoke:packaged` in CI) relies on.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
type BuildConfig = {
    appId: string;
    electronLanguages?: string[];
    files: string[];
    electronFuses?: Record<string, boolean>;
    win: Record<string, unknown>;
    mac: Record<string, unknown>;
    linux: Record<string, unknown>;
};
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    engines: { node: string };
    scripts: Record<string, string>;
    build: BuildConfig;
    devDependencies: Record<string, string>;
    allowScripts?: Record<string, boolean>;
};

describe('desktop packaging', () => {
    it('keeps the fuses the backend needs and closes the others', () => {
        expect(pkg.build.electronFuses).toEqual({
            // electron/backend.ts forks the backend with ELECTRON_RUN_AS_NODE.
            runAsNode: true,
            enableCookieEncryption: true,
            enableNodeOptionsEnvironmentVariable: false,
            enableNodeCliInspectArguments: false,
            enableEmbeddedAsarIntegrityValidation: true,
            onlyLoadAppFromAsar: true,
            // The UI is a file:// page.
            grantFileProtocolExtraPrivileges: true,
        });
    });

    it('ships only the UI languages and the target platform\'s native binaries', () => {
        expect(pkg.build.electronLanguages).toEqual(expect.arrayContaining(['en-US', 'es']));
        const files = pkg.build.files;
        const drop = files.indexOf('!**/node_modules/node-pty/prebuilds/**');
        const keep = files.indexOf('**/node_modules/node-pty/prebuilds/${platform}-${arch}/**');
        // Later patterns win: the target's own prebuild (node-pty's runtime binary) is put back.
        expect(drop).toBeGreaterThan(-1);
        expect(keep).toBeGreaterThan(drop);
        expect(files.indexOf('**/node_modules/sqlite3/build/Release/node_sqlite3.node')).toBeGreaterThan(files.indexOf('!**/node_modules/sqlite3/build/**'));
    });

    it('has no platform-level file list, which electron-builder would start from "**/*"', () => {
        // A list of exclusions only is read as "everything but": the whole
        // project (sources, tests, docs) ended up in app.asar.
        for (const platform of ['win', 'mac', 'linux'] as const) expect(pkg.build[platform]).not.toHaveProperty('files');
        expect(pkg.build.files.some((pattern) => !pattern.startsWith('!'))).toBe(true);
    });
});

describe('install', () => {
    it('allows the install scripts of the native modules (npm 12 blocks unlisted ones)', () => {
        for (const name of ['sqlite3', 'node-pty', 'ssh2']) expect(pkg.allowScripts?.[name], name).toBe(true);
    });

    it('checks the native modules after installing', () => {
        expect(pkg.scripts.postinstall).toBe('node scripts/check-native.mjs');
    });

    it('rebuilds a sqlite3 binary that cannot load here, and only such a one', () => {
        expect(UNLOADABLE.test("Error: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found (required by node_sqlite3.node)")).toBe(true);
        expect(UNLOADABLE.test('Error: Could not locate the bindings file. Tried: ...')).toBe(true);
        expect(UNLOADABLE.test("Error: Cannot find module 'sqlite3'")).toBe(false);
    });

    it('declares the Node versions the locked toolchain supports', () => {
        // jsdom 30 (and its undici) need ^22.22.2 or ^24.15; vitest 5 skips 23 and 25.
        expect(pkg.engines.node).toBe('^22.22.2 || ^24.15.0 || >=26');
    });

    it('carries no test dependencies nothing uses', () => {
        expect(pkg.devDependencies).not.toHaveProperty('supertest');
        expect(pkg.devDependencies).not.toHaveProperty('@types/supertest');
    });
});
