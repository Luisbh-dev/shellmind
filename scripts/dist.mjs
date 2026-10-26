// `npm run dist [-- options]`: packages the desktop app for this machine with
// electron-builder (targets and file lists: build in package.json), after
// `npm run build`.
//   --win | --mac | --linux   the platform (default: this machine's)
//   --arch x64|arm64          the architecture (default: this machine's)
//   --out <dir>               the output folder (default: release/)
//   --dir                     the unpacked app only, no installer
//
// The native modules (sqlite3, node-pty) are the ones in node_modules, built
// for this machine (npmRebuild is off), so a package is always for this
// machine's platform and architecture: Windows packages Windows, a Mac its own
// architecture. Linux packages come from the old-glibc container
// (scripts/dist-linux-docker.mjs), so that they run on older distributions.
//
// Code signing, when the credentials are there (CI secrets):
//   - Windows: WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD (a .pfx, path or base64).
//   - macOS: CSC_LINK and CSC_KEY_PASSWORD (a Developer ID .p12), or a
//     Developer ID identity in the keychain; signed with the hardened runtime,
//     then notarized with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
//     APPLE_TEAM_ID, or APPLE_API_KEY (the .p8 file or its text),
//     APPLE_API_KEY_ID and APPLE_API_ISSUER.
// Without a Developer ID the Mac app is signed ad hoc (identity "-"):
// electron-builder no longer does that on its own, and Apple Silicon refuses
// to start an app whose signature does not match its files (flipping the
// Electron fuses and the asar integrity change them). The hardened runtime is
// off then: it only matters for notarization, and under it an ad hoc app
// fails library validation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLATFORMS = { win: 'win32', mac: 'darwin', linux: 'linux' };
const ARCHS = ['x64', 'arm64'];
// GitHub passes an unset secret as an empty variable; electron-builder reads
// an empty CSC_LINK as "sign with nothing" instead of "not set".
export const SIGNING_VARIABLES = [
    'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
];

/**
 * @param {string[]} argv
 * @param {{ platform: string, arch: string }} host process.platform and process.arch
 * @returns {{ platform: 'win' | 'mac' | 'linux', arch: string, out: string | null, dir: boolean }}
 */
export function parseArgs(argv, host) {
    const options = { platform: null, arch: null, out: null, dir: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
            index += 1;
            return next;
        };
        if (arg === '--win' || arg === '--mac' || arg === '--linux') {
            if (options.platform && options.platform !== arg.slice(2)) throw new Error('Package one platform at a time');
            options.platform = arg.slice(2);
        } else if (arg === '--arch') options.arch = value();
        else if (arg === '--x64' || arg === '--arm64') options.arch = arg.slice(2);
        else if (arg === '--out') options.out = value();
        else if (arg === '--dir') options.dir = true;
        else throw new Error(`Unknown option ${arg}`);
    }
    const platform = options.platform ?? Object.keys(PLATFORMS).find((key) => PLATFORMS[key] === host.platform);
    if (!platform) throw new Error(`No desktop package for ${host.platform}`);
    const arch = options.arch ?? host.arch;
    if (!ARCHS.includes(arch)) throw new Error(`Unsupported architecture ${arch} (${ARCHS.join(' or ')})`);
    if (PLATFORMS[platform] !== host.platform || arch !== host.arch) {
        throw new Error(`This machine (${host.platform}-${host.arch}) cannot package ${PLATFORMS[platform]}-${arch}: the native modules in node_modules are built for this machine. Package on a ${PLATFORMS[platform]}-${arch} machine${platform === 'linux' ? ', or with `npm run dist:linux` (Docker)' : ''}.`);
    }
    return { platform, arch, out: options.out, dir: options.dir };
}

/** Removes the empty signing variables (see SIGNING_VARIABLES). @param {Record<string, string | undefined>} env */
export function dropEmptySigningVariables(env) {
    for (const name of SIGNING_VARIABLES) {
        if (env[name] !== undefined && env[name].trim() === '') delete env[name];
    }
}

/**
 * The macOS signing settings layered over build.mac.
 * @param {Record<string, string | undefined>} env without empty signing variables
 * @param {() => boolean} keychainHasDeveloperId whether the keychain holds a Developer ID Application identity
 * @returns {{ mode: 'developer-id' | 'ad-hoc', mac: Record<string, unknown> }}
 */
export function macSigning(env, keychainHasDeveloperId) {
    const discover = env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
    if (env.CSC_LINK || env.CSC_NAME || (discover && keychainHasDeveloperId())) {
        return { mode: 'developer-id', mac: { hardenedRuntime: true } };
    }
    return { mode: 'ad-hoc', mac: { identity: '-', hardenedRuntime: false, notarize: false } };
}

function keychainHasDeveloperId() {
    const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return result.status === 0 && /"Developer ID Application: /.test(result.stdout);
}

// electron-builder wants APPLE_API_KEY as a file; a CI secret holds its text.
function appleApiKeyFile(env) {
    const key = env.APPLE_API_KEY;
    if (!key || !key.includes('-----BEGIN')) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-notary-'));
    const file = path.join(dir, `AuthKey_${env.APPLE_API_KEY_ID ?? 'key'}.p8`);
    fs.writeFileSync(file, key, { mode: 0o600 });
    env.APPLE_API_KEY = file;
    return dir;
}

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
    const options = parseArgs(process.argv.slice(2), { platform: process.platform, arch: process.arch });
    for (const built of ['dist/index.html', 'dist-server/server.js', 'dist-electron/main.js', 'dist-electron/build-info.json']) {
        if (!fs.existsSync(path.join(root, built))) throw new Error(`${built} is missing: run \`npm run build\` first (\`npm run dist\` does).`);
    }
    dropEmptySigningVariables(process.env);

    const config = {};
    if (options.out) config.directories = { output: path.resolve(options.out) };
    let notaryDir = null;
    if (options.platform === 'mac') {
        const signing = macSigning(process.env, keychainHasDeveloperId);
        config.mac = signing.mac;
        if (signing.mode === 'developer-id') notaryDir = appleApiKeyFile(process.env);
        console.log(`[dist] macOS signing: ${signing.mode === 'ad-hoc' ? 'ad hoc (no Developer ID)' : 'Developer ID'}`);
    }

    const require = createRequire(path.join(root, 'package.json'));
    const { build } = require('electron-builder');
    try {
        const artifacts = await build({
            projectDir: root,
            [options.platform]: options.dir ? ['dir'] : [],
            [options.arch]: true,
            publish: 'never',
            config,
        });
        const files = artifacts.filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && !file.endsWith('.blockmap'));
        for (const file of files) {
            console.log(`[dist] ${path.basename(file)}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB  sha256 ${sha256(file)}`);
        }
    } finally {
        if (notaryDir) fs.rmSync(notaryDir, { recursive: true, force: true });
    }
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[dist] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
