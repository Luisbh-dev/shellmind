// `npm run smoke:packaged [-- <target>] [--launch]`: checks a packaged desktop
// app. <target> is an unpacked app (`electron-builder --dir`, default
// release/<platform>-unpacked) or what a release ships:
//   - .exe (Windows): the NSIS installer, installed silently into a temporary
//     folder and uninstalled afterwards (also checks that the uninstall
//     removes the files, the uninstall entry and the shortcuts, and that
//     neither leaves the installer's copy of itself in
//     %LOCALAPPDATA%\shellmind-updater: build/installer.nsh);
//   - .AppImage: extracted (--appimage-extract, no FUSE needed);
//   - .deb: extracted with dpkg-deb;
//   - .dmg: mounted read-only; .zip (macOS): extracted with ditto.
// The checks:
//   - nothing but the app is shipped: no database, key, .env file, log or
//     build leftover in app.asar or next to it;
//   - the package was built from this checkout's commit (or
//     SHELLMIND_BUILD_COMMIT's), without uncommitted changes unless
//     --allow-uncommitted: an installer left over from an earlier build fails;
//   - the Electron fuses match build.electronFuses in package.json (needs the
//     project's node_modules, skipped without them);
//   - the native modules load under the app's own runtime (ELECTRON_RUN_AS_NODE);
//   - the bundled backend starts from app.asar the way electron/backend.ts
//     forks it, on a fresh database: /api/health, the session token enforced,
//     every migration applied, and a saved password stored encrypted;
//   - the RDP gateway, under the app's runtime (BoringSSL), secures a
//     connection to a server whose certificate does not allow digital
//     signatures, like Windows' self-signed RDP ones, and refuses that
//     fallback when an attacker in the middle forces it on a server whose
//     certificate allows them (scripts/check-rdp-tls.mjs);
//   - macOS: the code signature verifies (ad hoc without a Developer ID).
// --launch also starts the app itself, with a temporary user data folder: its
// backend comes up (server.log), answers /api/health, the credentials key is
// created through the OS keychain (data-key.enc) and the database migrated;
// then the app is closed. It opens a window: run it on a desktop (Xvfb on Linux).
//
// Where there is no Node.js, the app's own runtime runs this script:
//   ELECTRON_RUN_AS_NODE=1 /opt/ShellMind/shellmind scripts/smoke-packaged.mjs /opt/ShellMind
import { fork, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkRdpTls } from './check-rdp-tls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
// Under Electron's runtime, fs reads an .asar archive as a folder.
const fs = process.versions.electron ? require('original-fs') : nodeFs;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const READY_TIMEOUT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 90_000;

class SmokeFailure extends Error {}
const fail = (message) => {
    throw new SmokeFailure(message);
};
const ok = (message) => console.log(`smoke: ok - ${message}`);
const note = (message) => console.log(`smoke: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function removeDir(dir) {
    try {
        // Windows keeps files of an exited process locked for a moment.
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
        console.warn(`smoke: could not remove ${dir}: ${error.message}`);
    }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, ...options });
    if (result.error) fail(`${command}: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}:\n${result.stderr || result.stdout}`);
    return result.stdout;
}

/** The executable and resources folder of the packaged app in `dir`, or null. */
function appIn(dir) {
    const productName = pkg.build.productName;
    const layouts = [
        { exe: path.join(dir, `${productName}.exe`), resources: path.join(dir, 'resources') },
        { exe: path.join(dir, pkg.name), resources: path.join(dir, 'resources') },
        { exe: path.join(dir, `${productName}.app`, 'Contents', 'MacOS', productName), resources: path.join(dir, `${productName}.app`, 'Contents', 'Resources'), bundle: path.join(dir, `${productName}.app`) },
    ];
    return layouts.find((layout) => fs.existsSync(layout.exe) && fs.existsSync(path.join(layout.resources, 'app.asar'))) ?? null;
}

function requireApp(dir, what) {
    return appIn(dir) ?? fail(`no packaged ${pkg.build.productName} app in ${what}`);
}

// --- Targets -----------------------------------------------------------------

const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

function uninstallEntriesFor(dir) {
    const result = spawnSync('reg', ['query', UNINSTALL_KEY, '/s', '/f', dir, '/d'], { encoding: 'utf8' });
    return (result.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith('HKEY_'));
}

function shortcuts() {
    const name = `${pkg.build.productName}.lnk`;
    return [
        path.join(os.homedir(), 'Desktop', name),
        path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', name),
    ];
}

/**
 * Where electron-builder's NSIS installer copies itself for electron-updater
 * (APP_INSTALLER_STORE_FILE, %LOCALAPPDATA%\<name>-updater\installer.exe), or
 * null without LOCALAPPDATA. ShellMind has no updater: build/installer.nsh
 * deletes that copy after installing and on uninstall.
 * @param {Record<string, string | undefined>} env @param {string} name the package name
 */
export function installerStoreCopy(env = process.env, name = pkg.name) {
    return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, `${name.toLowerCase()}-updater`, 'installer.exe') : null;
}

// After a failed check, so that it leaves no copy of the installer behind;
// the folder only goes when nothing else is in it.
function removeStoreCopy(file) {
    fs.rmSync(file, { force: true });
    try {
        fs.rmdirSync(path.dirname(file));
    } catch {
        // Not empty, or already gone.
    }
}

async function installNsis(installer) {
    const dir = tempDir('shellmind-install-');
    // NSIS takes /D= last and unquoted, so the folder cannot hold a space.
    if (/\s/.test(dir)) fail(`the temporary folder ${dir} has a space, which the NSIS /D= option cannot take`);
    const shortcutsBefore = new Set(shortcuts().filter((file) => fs.existsSync(file)));
    const storeCopy = installerStoreCopy() ?? fail('LOCALAPPDATA is not set');
    run(installer, ['/S', `/D=${dir}`]);
    const app = requireApp(dir, `${dir} after the silent install`);
    const uninstaller = path.join(dir, `Uninstall ${pkg.build.productName}.exe`);
    if (!fs.existsSync(uninstaller)) fail(`no uninstaller in ${dir}`);
    if (uninstallEntriesFor(dir).length === 0) fail('the installer did not register the app in Apps & features');

    const uninstall = async () => {
        // The uninstaller copies itself to %TEMP% and exits at once; the copy
        // removes the files, then the uninstall entry and the shortcuts.
        run(uninstaller, ['/S']);
        const leftovers = () => [
            ...(fs.existsSync(app.exe) || fs.existsSync(uninstaller) ? [`the files in ${dir}`] : []),
            ...uninstallEntriesFor(dir).map((key) => `the uninstall entry ${key}`),
            ...shortcuts().filter((file) => fs.existsSync(file) && !shortcutsBefore.has(file)),
            ...(fs.existsSync(storeCopy) ? [`the installer's copy of itself ${storeCopy}`] : []),
        ];
        const deadline = Date.now() + 120_000;
        for (let left = leftovers(); left.length; left = leftovers()) {
            if (Date.now() > deadline) {
                removeStoreCopy(storeCopy);
                fail(`the silent uninstall left behind, after 2 minutes: ${left.join(', ')}`);
            }
            await sleep(500);
        }
        removeDir(dir);
        ok(`uninstalled silently: files, uninstall entry and shortcuts removed, no copy of the installer left in ${path.dirname(storeCopy)}`);
    };

    if (fs.existsSync(storeCopy)) {
        const size = fs.statSync(storeCopy).size;
        removeStoreCopy(storeCopy);
        await uninstall().catch((error) => console.error(`smoke: cleanup failed too: ${error.message}`));
        fail(`the installer left a copy of itself (${(size / 1024 / 1024).toFixed(1)} MB, for electron-updater, which ShellMind does not use) in ${storeCopy}: build/installer.nsh must delete it (the smoke test removed it)`);
    }
    ok(`installed silently into ${dir}, without leaving a copy of the installer in ${path.dirname(storeCopy)}`);
    return { app, cleanup: uninstall };
}

function extractAppImage(file) {
    const dir = tempDir('shellmind-appimage-');
    const copy = path.join(dir, path.basename(file));
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o755);
    run(copy, ['--appimage-extract'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    fs.rmSync(copy);
    ok(`extracted ${path.basename(file)}`);
    return { app: requireApp(path.join(dir, 'squashfs-root'), `the AppImage ${file}`), cleanup: () => removeDir(dir) };
}

function extractDeb(file) {
    const fields = run('dpkg-deb', ['--field', file, 'Package', 'Version', 'Architecture', 'Depends']).trim();
    note(`deb control: ${fields.replace(/\n/g, '; ')}`);
    const dir = tempDir('shellmind-deb-');
    run('dpkg-deb', ['-x', file, dir]);
    const app = requireApp(path.join(dir, 'opt', pkg.build.productName), `the deb ${file} (opt/${pkg.build.productName})`);
    if (!fs.existsSync(path.join(dir, 'usr', 'share', 'applications', `${pkg.name}.desktop`))) fail('the deb has no desktop entry');
    ok(`extracted ${path.basename(file)}`);
    return { app, cleanup: () => removeDir(dir) };
}

function mountDmg(file) {
    const mount = tempDir('shellmind-dmg-');
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file]);
    ok(`mounted ${path.basename(file)}`);
    const detach = () => {
        if (spawnSync('hdiutil', ['detach', mount]).status !== 0) spawnSync('hdiutil', ['detach', '-force', mount]);
        removeDir(mount);
    };
    try {
        return { app: requireApp(mount, `the disk image ${file}`), cleanup: detach };
    } catch (error) {
        detach();
        throw error;
    }
}

function extractZip(file) {
    const dir = tempDir('shellmind-zip-');
    run('ditto', ['-x', '-k', file, dir]);
    ok(`extracted ${path.basename(file)}`);
    return { app: requireApp(dir, `the archive ${file}`), cleanup: () => removeDir(dir) };
}

async function openTarget(target) {
    if (!target) {
        const dirs = ['win-unpacked', 'linux-unpacked', 'mac', 'mac-arm64', 'mac-universal'].map((dir) => path.join(root, pkg.build.directories.output, dir));
        const app = dirs.map(appIn).find(Boolean) ?? fail(`no packaged app in ${dirs.join(', ')} (build one with \`node scripts/dist.mjs --dir\`)`);
        return { app, cleanup: () => {} };
    }
    const file = path.resolve(target);
    if (!fs.existsSync(file)) fail(`${file} does not exist`);
    if (fs.statSync(file).isDirectory()) return { app: requireApp(file, file), cleanup: () => {} };
    const ext = path.extname(file).toLowerCase();
    if (ext === '.exe' && process.platform === 'win32') return installNsis(file);
    if (ext === '.appimage' && process.platform === 'linux') return extractAppImage(file);
    if (ext === '.deb' && process.platform === 'linux') return extractDeb(file);
    if (ext === '.dmg' && process.platform === 'darwin') return mountDmg(file);
    if (ext === '.zip' && process.platform === 'darwin') return extractZip(file);
    return fail(`cannot check ${path.basename(file)} on ${process.platform}`);
}

// --- What is shipped ---------------------------------------------------------

// app.asar is a Chromium pickle (two uint32: 4, header size) holding a pickled
// string (uint32 payload size, uint32 length, JSON) that lists the files.
function asarFiles(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const sizes = Buffer.alloc(8);
        fs.readSync(fd, sizes, 0, 8, 0);
        const header = Buffer.alloc(sizes.readUInt32LE(4));
        fs.readSync(fd, header, 0, header.length, 8);
        const tree = JSON.parse(header.toString('utf8', 8, 8 + header.readUInt32LE(4)));
        const files = [];
        const walk = (node, prefix) => {
            for (const [name, entry] of Object.entries(node.files ?? {})) {
                const relative = prefix ? `${prefix}/${name}` : name;
                if (entry.files) walk(entry, relative);
                else files.push(relative);
            }
        };
        walk(tree, '');
        return files;
    } finally {
        fs.closeSync(fd);
    }
}

// A file's bytes in app.asar: its header entry gives the offset after the
// header (an unpacked file has none).
function asarRead(file, relative) {
    const fd = fs.openSync(file, 'r');
    try {
        const sizes = Buffer.alloc(8);
        fs.readSync(fd, sizes, 0, 8, 0);
        const headerSize = sizes.readUInt32LE(4);
        const header = Buffer.alloc(headerSize);
        fs.readSync(fd, header, 0, header.length, 8);
        let node = JSON.parse(header.toString('utf8', 8, 8 + header.readUInt32LE(4)));
        for (const name of relative.split('/')) node = node?.files?.[name];
        if (!node || node.files || node.unpacked || node.offset === undefined) return null;
        const data = Buffer.alloc(node.size);
        fs.readSync(fd, data, 0, data.length, 8 + headerSize + Number(node.offset));
        return data;
    } finally {
        fs.closeSync(fd);
    }
}

function filesUnder(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return filesUnder(path.join(dir, entry.name), relative);
        return [relative];
    });
}

// Data of a development machine that must never end up in a package.
export const SHIPPED_DATA = [
    { pattern: /\.(db|sqlite|sqlite3)$|\.db-(wal|shm|journal)$/i, what: 'database' },
    { pattern: /(^|\/)\.env($|\.)/i, what: '.env file' },
    { pattern: /(^|\/)(shellmind\.key|data-key|data-key\.enc)$|\.(pem|p12|pfx|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, what: 'key or certificate' },
    { pattern: /\.log$|(^|\/)window-theme\.json$/i, what: 'log or user data' },
    { pattern: /\.(map|tsbuildinfo|pdb)$/i, what: 'build leftover' },
];
// The only top-level entries of app.asar (build.files in package.json).
export const ASAR_TOP_LEVEL = new Set(['dist', 'dist-electron', 'dist-server', 'node_modules', 'package.json']);

/** @param {string[]} asarList files in app.asar @param {string[]} resourceList files beside it */
export function shippedProblems(asarList, resourceList) {
    const problems = [];
    for (const [where, files] of [['app.asar', asarList], ['resources', resourceList]]) {
        for (const file of files) {
            const match = SHIPPED_DATA.find(({ pattern }) => pattern.test(file));
            if (match) problems.push(`${where}: ${file} (${match.what})`);
        }
    }
    for (const top of new Set(asarList.map((file) => file.split('/')[0]))) {
        if (!ASAR_TOP_LEVEL.has(top)) problems.push(`app.asar: ${top} (not part of the app)`);
    }
    return problems;
}

function checkShipped(app) {
    const asar = asarFiles(path.join(app.resources, 'app.asar'));
    const beside = filesUnder(app.resources).filter((file) => file !== 'app.asar');
    const problems = shippedProblems(asar, beside);
    if (problems.length) fail(`the package ships files it must not:\n  ${problems.join('\n  ')}`);
    for (const required of ['dist/index.html', 'dist-server/server.js', 'dist-electron/main.js', 'package.json']) {
        if (!asar.includes(required)) fail(`app.asar has no ${required}`);
    }
    ok(`ships only the app: ${asar.length} files in app.asar, ${beside.length} beside it, no databases, keys, .env files or logs`);
}

/**
 * What is wrong with the commit a package records (scripts/build-info.mjs).
 * @param {{ commit: string | null, dirty: boolean, version?: string } | null} info build-info.json of the package
 * @param {{ commit: string | null, version: string, allowUncommitted: boolean }} expected
 *   commit: the checkout's HEAD (or SHELLMIND_BUILD_COMMIT), null when unknown
 * @returns {string | null}
 */
export function provenanceProblem(info, expected) {
    if (!info) return 'the package records no build commit (dist-electron/build-info.json): it was built without `npm run build`';
    if (info.version !== expected.version) return `the package is version ${info.version}, this checkout ${expected.version}`;
    if (!expected.commit) return null;
    if (!info.commit) return `the package records no commit, this checkout is at ${expected.commit}`;
    if (info.commit !== expected.commit) return `the package was built from commit ${info.commit}, this checkout is at ${expected.commit}: rebuild it from the current commit`;
    if (info.dirty && !expected.allowUncommitted) return `the package was built from ${info.commit} with uncommitted changes: commit them and rebuild (--allow-uncommitted accepts it for a local test)`;
    return null;
}

function checkoutCommit() {
    if (process.env.SHELLMIND_BUILD_COMMIT) return process.env.SHELLMIND_BUILD_COMMIT.trim();
    const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function checkProvenance(app, allowUncommitted) {
    const data = asarRead(path.join(app.resources, 'app.asar'), 'dist-electron/build-info.json');
    let info = null;
    try {
        info = data ? JSON.parse(data.toString('utf8')) : null;
    } catch {
        fail('dist-electron/build-info.json in app.asar is not valid JSON');
    }
    const commit = checkoutCommit();
    const problem = provenanceProblem(info, { commit, version: pkg.version, allowUncommitted });
    if (problem) fail(problem);
    if (!commit) return note(`built from ${info.commit ?? 'an unknown commit'}; not compared: no git checkout here`);
    ok(`built from this checkout's commit ${commit.slice(0, 12)}${info.dirty ? ' (with uncommitted changes)' : ''}`);
}

// --- Runtime -----------------------------------------------------------------

async function checkFuses(exe) {
    const expected = pkg.build.electronFuses;
    if (!expected) return ok('no electronFuses configured');
    let fuses;
    try {
        fuses = require('@electron/fuses');
    } catch {
        return note('fuses not checked: @electron/fuses is not installed here (run from a checkout with node_modules)');
    }
    const { getCurrentFuseWire, FuseV1Options } = fuses;
    // The wire holds one ASCII character per fuse: '1' on, '0' off.
    const ENABLE = '1'.charCodeAt(0);
    const DISABLE = '0'.charCodeAt(0);
    const wire = await getCurrentFuseWire(exe);
    const wrong = [];
    for (const [key, enabled] of Object.entries(expected)) {
        const option = FuseV1Options[key[0].toUpperCase() + key.slice(1)];
        if (option === undefined) continue;
        if (wire[option] !== (enabled ? ENABLE : DISABLE)) wrong.push(`${key} should be ${enabled ? 'on' : 'off'}`);
    }
    if (wrong.length) fail(`fuses: ${wrong.join(', ')}`);
    ok(`fuses as configured (${Object.entries(expected).map(([key, on]) => `${key}=${on}`).join(', ')})`);
}

// Runs `code` under the app's runtime and returns the JSON of its last output line.
function runInApp(exe, code, cwd) {
    const result = spawnSync(exe, ['-e', code], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) fail(`the app runtime failed:\n${result.stderr || result.stdout || result.error}`);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

function checkNatives(exe, asar) {
    const modules = path.join(asar, 'node_modules');
    const info = runInApp(exe, [
        `require(${JSON.stringify(path.join(modules, 'sqlite3'))});`,
        `require(${JSON.stringify(path.join(modules, 'node-pty'))});`,
        `const crypto = require(${JSON.stringify(path.join(modules, 'ssh2', 'lib', 'protocol', 'crypto.js'))});`,
        'process.stdout.write(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, ssh2Binding: crypto.bindingAvailable }));',
    ].join('\n'));
    ok(`sqlite3 and node-pty load under Electron ${info.electron} (Node ${info.node}); ssh2 native crypto binding: ${info.ssh2Binding ? 'yes' : 'no (JavaScript fallback)'}`);
}

// The schema version and the stored passwords of a database the backend has closed.
function inspectDatabase(exe, asar, file) {
    return runInApp(exe, [
        `const sqlite3 = require(${JSON.stringify(path.join(asar, 'node_modules', 'sqlite3'))});`,
        `const { SCHEMA_VERSION } = require(${JSON.stringify(path.join(asar, 'dist-server', 'server', 'db', 'migrations.js'))});`,
        `const db = new sqlite3.Database(${JSON.stringify(file)}, sqlite3.OPEN_READONLY, (error) => { if (error) { console.error(error.message); process.exit(1); } });`,
        "db.get('PRAGMA user_version', (error, version) => {",
        '    if (error) { console.error(error.message); process.exit(1); }',
        "    db.all('SELECT password FROM servers', (error, rows) => {",
        '        if (error) { console.error(error.message); process.exit(1); }',
        '        db.close(() => process.stdout.write(JSON.stringify({ version: version.user_version, schema: SCHEMA_VERSION, passwords: rows.map((row) => row.password) })));',
        '    });',
        '});',
    ].join('\n'), path.dirname(file));
}

function checkMigrated(database) {
    if (!(database.schema > 0)) fail('the bundled backend reports no schema version');
    if (database.version !== database.schema) fail(`the database is at schema v${database.version}, the backend's latest is v${database.schema}`);
}

function startBackend(exe, entry, dataDir, token) {
    const child = fork(entry, [], {
        execPath: exe,
        cwd: dataDir,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            HOST: '127.0.0.1',
            PORT: '0',
            DB_PATH: path.join(dataDir, 'shellmind.db'),
            SHELLMIND_AUTH_TOKEN: token,
            SHELLMIND_DATA_KEY: randomBytes(32).toString('base64'),
            SHELLMIND_VERSION: pkg.version,
            DOTENV_CONFIG_PATH: path.join(dataDir, 'missing.env'),
        },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ready message within ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
        child.on('message', (message) => {
            if (message?.type === 'ready') {
                clearTimeout(timer);
                resolve(message.port);
            } else if (message?.type === 'fatal') {
                clearTimeout(timer);
                reject(new Error(message.message));
            }
        });
        void exited.then(({ code, signal }) => {
            clearTimeout(timer);
            reject(new Error(`the backend exited (${signal ?? `code ${code}`}) before it was ready`));
        });
    });
    return { child, ready, exited, output: () => output };
}

async function checkBackend(exe, asar) {
    const entry = path.join(asar, 'dist-server', 'server.js');
    const dataDir = tempDir('shellmind-smoke-');
    const token = randomBytes(24).toString('base64url');
    const backend = startBackend(exe, entry, dataDir, token);
    try {
        const port = await backend.ready.catch((error) => fail(`backend: ${error.message}\n${backend.output()}`));
        const base = `http://127.0.0.1:${port}`;
        const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

        const health = await fetch(`${base}/api/health`);
        if (health.status !== 200) fail(`/api/health answered ${health.status}`);
        const body = await health.json();
        if (body.version !== pkg.version) fail(`/api/health reports version ${body.version}, the package is ${pkg.version}`);
        ok(`backend ready on port ${port}, /api/health ${JSON.stringify(body)}`);

        if ((await fetch(`${base}/api/servers`)).status !== 401) fail('/api/servers answered without the session token');
        const password = `smoke-${randomBytes(12).toString('hex')}`;
        const created = await fetch(`${base}/api/servers`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ name: 'smoke', ip: '192.0.2.10', type: 'linux', port: 22, username: 'smoke', password }),
        });
        if (created.status !== 200) fail(`POST /api/servers answered ${created.status}: ${await created.text()}`);
        const listed = await fetch(`${base}/api/servers`, { headers: auth });
        const listing = await listed.text();
        if (listed.status !== 200) fail(`/api/servers answered ${listed.status}: ${listing}`);
        if (listing.includes(password)) fail('/api/servers returned a saved password');
        if (!JSON.parse(listing).data?.some?.((server) => server.has_password)) fail('/api/servers does not report the saved password');
        ok('session token enforced; a server with a password saved and listed without it');

        backend.child.send({ type: 'shutdown' });
        const timer = setTimeout(() => backend.child.kill(), 10_000);
        const { code, signal } = await backend.exited;
        clearTimeout(timer);
        if (code !== 0) fail(`the backend did not shut down cleanly (${signal ?? `code ${code}`})\n${backend.output()}`);
        ok('backend shut down cleanly');

        const database = inspectDatabase(exe, asar, path.join(dataDir, 'shellmind.db'));
        checkMigrated(database);
        const [stored] = database.passwords;
        if (!stored?.startsWith('enc:v1:') || stored.includes(password)) fail(`the password is not stored encrypted (${stored?.slice(0, 12)}...)`);
        ok(`fresh database migrated to schema v${database.version}; the password is stored encrypted (enc:v1, AES-256-GCM)`);
    } finally {
        if (backend.child.exitCode === null && backend.child.signalCode === null) {
            backend.child.kill();
            await Promise.race([backend.exited, sleep(10_000)]);
        }
        removeDir(dataDir);
    }
}

async function checkRdpGatewayTls(exe, asar) {
    const summary = await checkRdpTls({ runtime: exe, serverDir: path.join(asar, 'dist-server') }).catch((error) => fail(`RDP gateway TLS: ${error.message}`));
    ok(summary);
}

function checkMacSignature(bundle) {
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { encoding: 'utf8' });
    if (verify.status !== 0) fail(`the code signature does not verify (Apple Silicon refuses to start it):\n${verify.stderr}`);
    const details = spawnSync('codesign', ['--display', '--verbose=2', bundle], { encoding: 'utf8' }).stderr ?? '';
    const authority = /^Authority=(.+)$/m.exec(details)?.[1];
    const kind = /Signature=adhoc/.test(details) ? 'ad hoc' : authority ?? 'unknown signer';
    const arch = spawnSync('lipo', ['-archs', path.join(bundle, 'Contents', 'MacOS', pkg.build.productName)], { encoding: 'utf8' }).stdout?.trim();
    ok(`code signature verifies (${kind}${arch ? `, ${arch}` : ''})`);
}

// --- The app itself (--launch) -----------------------------------------------

async function stopApp(child) {
    const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
    });
    const within = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
    // A close request to the app alone, as when the user closes the window:
    // it stops its backend before it exits. (taskkill /T would ask the helper
    // processes first, which only stop by force, and then refuse the app; a
    // signal to the whole process group would stop the backend under it.)
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid)]);
    else process.kill(child.pid, 'SIGTERM');
    if (await within(20_000)) return true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
    await within(10_000);
    return false;
}

async function checkLaunch(app) {
    const userData = tempDir('shellmind-userdata-');
    const args = [`--user-data-dir=${userData}`];
    // Chromium's sandbox refuses root (containers).
    if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(app.exe, args, { env, stdio: 'ignore', detached: process.platform !== 'win32' });
    const log = path.join(userData, 'server.log');
    try {
        let port = null;
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
        while (port === null) {
            if (child.exitCode !== null || child.signalCode !== null) fail(`the app exited (${child.signalCode ?? `code ${child.exitCode}`}) before its backend was ready${fs.existsSync(log) ? `:\n${fs.readFileSync(log, 'utf8')}` : ''}`);
            if (Date.now() > deadline) fail(`the app's backend was not ready within ${LAUNCH_TIMEOUT_MS / 1000} s (no "Backend ready" in ${log})`);
            const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
            const failed = /Backend start failed: (.+)/.exec(text);
            if (failed) fail(`the app could not start its backend: ${failed[1]}`);
            port = /Backend ready on 127\.0\.0\.1:(\d+)/.exec(text)?.[1] ?? null;
            if (port === null) await sleep(500);
        }
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.status !== 200) fail(`the app's backend answered /api/health with ${health.status}`);
        if ((await fetch(`http://127.0.0.1:${port}/api/servers`)).status !== 401) fail("the app's backend answered without the session token");
        ok(`the app started with user data in ${userData}; its backend is up on port ${port}`);

        const keyFile = ['data-key.enc', 'data-key'].find((name) => fs.existsSync(path.join(userData, name)));
        if (!keyFile) fail('the app created no credentials key in its user data folder');
        if (keyFile === 'data-key') note('no OS keychain here: the credentials key is stored unencrypted (data-key)');
        // Linux without a keyring (a container, a bare window manager).
        else if (fs.readFileSync(log, 'utf8').includes('safeStorage basic_text')) note('credentials key created (data-key.enc), only obfuscated: no OS keychain here (safeStorage basic_text)');
        else ok('credentials key created, encrypted by the OS keychain (data-key.enc)');

        if (!(await stopApp(child))) fail('the app did not close on a close request within 20 s');
        const stillUp = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);
        if (stillUp) fail("the app's backend kept running after the app closed");
        const database = inspectDatabase(app.exe, path.join(app.resources, 'app.asar'), path.join(userData, 'shellmind.db'));
        checkMigrated(database);
        ok(`the app closed with its backend; its database is at schema v${database.version}`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) await stopApp(child);
        removeDir(userData);
    }
}

// --- Main --------------------------------------------------------------------

function sizeOf(target) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

async function main() {
    const args = process.argv.slice(2);
    const launch = args.includes('--launch');
    const target = args.find((arg) => !arg.startsWith('--'));
    const { app, cleanup } = await openTarget(target);
    let failure = null;
    try {
        const asar = path.join(app.resources, 'app.asar');
        console.log(`smoke: ${app.exe}`);
        checkShipped(app);
        checkProvenance(app, args.includes('--allow-uncommitted'));
        await checkFuses(app.exe);
        checkNatives(app.exe, asar);
        await checkBackend(app.exe, asar);
        await checkRdpGatewayTls(app.exe, asar);
        if (app.bundle) checkMacSignature(app.bundle);
        if (launch) await checkLaunch(app);
        const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        const unpacked = path.join(app.resources, 'app.asar.unpacked');
        console.log(`smoke: app.asar ${mb(fs.statSync(asar).size)}, app.asar.unpacked ${fs.existsSync(unpacked) ? mb(sizeOf(unpacked)) : '-'}`);
    } catch (error) {
        failure = error;
    }
    // An installed app is uninstalled whatever happened; the first failure is the one reported.
    try {
        await cleanup();
    } catch (error) {
        if (!failure) throw error;
        console.error(`smoke: cleanup failed too: ${error.message}`);
    }
    if (failure) throw failure;
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    main().then(() => console.log('smoke: passed'), (error) => {
        console.error(`smoke: FAILED: ${error instanceof SmokeFailure ? error.message : error?.stack ?? error}`);
        process.exit(1);
    });
}
