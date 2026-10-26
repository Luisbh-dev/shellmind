import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_INFO_FILE, buildInfo } from '../../scripts/build-info.mjs';
import { ASAR_TOP_LEVEL, installerStoreCopy, provenanceProblem, shippedProblems } from '../../scripts/smoke-packaged.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The "nothing but the app is shipped" check of `npm run smoke:packaged`: a
// package built on a developer's machine must not carry its databases, keys,
// .env files or logs.

const APP = [
    'package.json',
    'dist/index.html',
    'dist/assets/index-abc123.js',
    'dist-server/server.js',
    'dist-server/server/db/migrations.js',
    'dist-electron/main.js',
    'node_modules/sqlite3/lib/sqlite3.js',
    'node_modules/ssh2/lib/keygen.js',
    'node_modules/dotenv/lib/main.js',
];
const BESIDE = ['app.asar.unpacked/node_modules/sqlite3/build/Release/node_sqlite3.node', 'build/icon.png', 'elevate.exe'];

describe('shipped files', () => {
    it('passes the app, its dependencies and its icons', () => {
        expect(shippedProblems(APP, BESIDE)).toEqual([]);
    });

    it('finds databases, data keys, .env files, SSH keys and logs', () => {
        const problems = shippedProblems(
            [...APP, 'dist-server/shellmind.db', 'dist-server/shellmind.db-wal', 'dist-server/shellmind.key', 'dist-server/.env', 'node_modules/x/.env.local'],
            [...BESIDE, 'data-key.enc', 'server.log', 'keys/id_ed25519', 'certs/signing.p12'],
        );
        expect(problems).toEqual([
            'app.asar: dist-server/shellmind.db (database)',
            'app.asar: dist-server/shellmind.db-wal (database)',
            'app.asar: dist-server/shellmind.key (key or certificate)',
            'app.asar: dist-server/.env (.env file)',
            'app.asar: node_modules/x/.env.local (.env file)',
            'resources: data-key.enc (key or certificate)',
            'resources: server.log (log or user data)',
            'resources: keys/id_ed25519 (key or certificate)',
            'resources: certs/signing.p12 (key or certificate)',
        ]);
    });

    it('finds build leftovers and anything outside the app folders', () => {
        const problems = shippedProblems([...APP, 'dist/assets/index-abc123.js.map', 'src/App.tsx', 'tsconfig.tsbuildinfo'], [...BESIDE, 'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.pdb']);
        expect(problems).toEqual([
            'app.asar: dist/assets/index-abc123.js.map (build leftover)',
            'app.asar: tsconfig.tsbuildinfo (build leftover)',
            'resources: app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.pdb (build leftover)',
            'app.asar: src (not part of the app)',
            'app.asar: tsconfig.tsbuildinfo (not part of the app)',
        ]);
        expect([...ASAR_TOP_LEVEL].sort()).toEqual(['dist', 'dist-electron', 'dist-server', 'node_modules', 'package.json']);
    });

    it('does not mistake look-alike names for data', () => {
        expect(shippedProblems([...APP, 'node_modules/x/environment.js', 'node_modules/x/keyboard.js', 'node_modules/x/db.js', 'node_modules/x/logger.js'], BESIDE)).toEqual([]);
    });
});

// UX-01: installers built before the last merges (without the PowerShell
// delivery over stdin) nearly reached the 1.0.0 release. The smoke test now
// fails a package built from another commit than the checkout's.
describe('package provenance', () => {
    const commit = 'a'.repeat(40);
    const expected = { commit, version: '1.0.0', allowUncommitted: false };

    it('passes a package built from the checkout\'s commit', () => {
        expect(provenanceProblem({ version: '1.0.0', commit, dirty: false }, expected)).toBeNull();
        expect(provenanceProblem({ version: '1.0.0', commit, dirty: true }, { ...expected, allowUncommitted: true })).toBeNull();
    });

    it('fails a package from another commit, with uncommitted changes, without a record or of another version', () => {
        expect(provenanceProblem({ version: '1.0.0', commit: 'b'.repeat(40), dirty: false }, expected)).toMatch(/built from commit b{40}, this checkout is at a{40}: rebuild it/);
        expect(provenanceProblem({ version: '1.0.0', commit, dirty: true }, expected)).toMatch(/uncommitted changes/);
        expect(provenanceProblem(null, expected)).toMatch(/records no build commit/);
        expect(provenanceProblem({ version: '1.0.0', commit: null, dirty: false }, expected)).toMatch(/records no commit/);
        expect(provenanceProblem({ version: '0.9.0', commit, dirty: false }, expected)).toMatch(/version 0\.9\.0/);
    });

    it('only checks the version where the commit is unknown (a distribution container without git)', () => {
        expect(provenanceProblem({ version: '1.0.0', commit, dirty: false }, { ...expected, commit: null })).toBeNull();
    });
});

// electron-builder's NSIS installer copied itself (107 MB) to
// %LOCALAPPDATA%\shellmind-updater\installer.exe on every install, for an
// updater ShellMind does not have, and the uninstaller left it there. The smoke
// test fails an installer that leaves it after installing or uninstalling.
describe('installer copy', () => {
    it('is where electron-builder stores it: <name>-updater\\installer.exe in the user\'s local app data', () => {
        expect(installerStoreCopy({ LOCALAPPDATA: 'C:\\Users\\ops\\AppData\\Local' }, 'shellmind')).toBe('C:\\Users\\ops\\AppData\\Local\\shellmind-updater\\installer.exe');
        expect(installerStoreCopy({ LOCALAPPDATA: 'C:\\Users\\ops\\AppData\\Local' })).toBe('C:\\Users\\ops\\AppData\\Local\\shellmind-updater\\installer.exe');
        expect(installerStoreCopy({})).toBeNull();
    });

    it('is deleted by build/installer.nsh after installing and on uninstall, and nothing else is', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { build: { nsis: { include?: string } } };
        expect(pkg.build.nsis.include).toBe('build/installer.nsh');
        const script = fs.readFileSync(path.join(repoRoot, 'build', 'installer.nsh'), 'utf8');
        expect(script).toMatch(/^!macro customInstall\r?$/m);
        expect(script).toMatch(/^!macro customUnInstall\r?$/m);
        expect(script).toContain('${APP_INSTALLER_STORE_FILE}');
        expect(script).toContain('ReadEnvStr $0 LOCALAPPDATA');
        expect(script).toMatch(/^\s*Delete "\$0\\\$\{SHELLMIND_INSTALLER_COPY\}"\r?$/m);
        // No recursive removal and no wildcard: RMDir only takes the folder when it is empty.
        expect(script).not.toMatch(/RMDir\s+\/r/i);
        expect(script).not.toContain('*');
    });
});

describe('build info', () => {
    const head = 'c'.repeat(40);
    const git = (answers: Record<string, string | null>) => (args: string[]) => answers[args.join(' ')] ?? null;

    it('records the checkout\'s commit and whether tracked files changed', () => {
        expect(buildInfo({ version: '1.0.0', env: {}, git: git({ 'rev-parse HEAD': head, 'status --porcelain --untracked-files=no': '' }) })).toEqual({ version: '1.0.0', commit: head, dirty: false });
        expect(buildInfo({ version: '1.0.0', env: {}, git: git({ 'rev-parse HEAD': head, 'status --porcelain --untracked-files=no': ' M server.ts' }) })).toEqual({ version: '1.0.0', commit: head, dirty: true });
        expect(buildInfo({ version: '1.0.0', env: {}, git: git({}) })).toEqual({ version: '1.0.0', commit: null, dirty: false });
    });

    it('takes the commit the Linux container is given, which has no .git', () => {
        expect(buildInfo({ version: '1.0.0', env: { SHELLMIND_BUILD_COMMIT: head }, git: git({}) })).toEqual({ version: '1.0.0', commit: head, dirty: false });
        expect(() => buildInfo({ version: '1.0.0', env: { SHELLMIND_BUILD_COMMIT: 'HEAD' }, git: git({}) })).toThrow(/not a full commit id/);
    });

    it('is written by npm run build and required by npm run dist', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts.build.endsWith('&& node scripts/build-info.mjs')).toBe(true);
        expect(fs.readFileSync(path.join(repoRoot, 'scripts', 'dist.mjs'), 'utf8')).toContain("'dist-electron/build-info.json'");
        expect(BUILD_INFO_FILE).toBe('dist-electron/build-info.json');
    });
});
