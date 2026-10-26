// electron-builder afterPack hook (package.json build.afterPack): checks the
// native modules of a packed app before it becomes an installer or AppImage.
//   - Every platform: sqlite3's and node-pty's binaries are in
//     app.asar.unpacked. A files/asarUnpack change could drop them, and the
//     backend cannot start without sqlite3.
//   - Linux: no native module needs a newer glibc or libstdc++ than the oldest
//     distribution the package is for. npmRebuild is off, so the package ships
//     the binaries of the build machine's node_modules; sqlite3's prebuilt one
//     needs glibc 2.38, and anything compiled on a newer Linux may need more
//     than the baseline. Such a package fails at startup on older systems
//     ("The backend exited during startup").
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compareVersions, elfVersionNeeds, newestVersions } from './elf-versions.mjs';

// Debian 11 and Ubuntu 20.04 (glibc 2.31, GCC 10's libstdc++), and so every
// newer Debian, Ubuntu, Fedora and RHEL 9. The Linux packages are built in a
// Debian 11 container (`npm run dist:linux`), whose compiler stays within it.
export const LINUX_BASELINE = { GLIBC: '2.31', GLIBCXX: '3.4.28', CXXABI: '1.3.12' };
export const LINUX_BASELINE_NAME = 'Debian 11, Ubuntu 20.04';
// Set to package for the build machine's Linux (and newer) only.
export const SKIP_LINUX_CHECK_ENV = 'SHELLMIND_SKIP_GLIBC_CHECK';
const REQUIRED_MODULES = ['sqlite3', 'node-pty'];

/** @param {string} dir @returns {string[]} */
function nativeFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort();
}

/**
 * @param {{ platform: string, unpackedDir: string, env?: Record<string, string | undefined> }} options
 *   platform: electron-builder's electronPlatformName (linux, win32, darwin, mas)
 * @returns {{ errors: string[], warnings: string[], notes: string[] }}
 */
export function checkPackedNatives({ platform, unpackedDir, env = process.env }) {
    const errors = [];
    const warnings = [];
    const notes = [];
    const files = nativeFiles(unpackedDir);
    const relative = (file) => path.relative(unpackedDir, file).split(path.sep).join('/');

    for (const name of REQUIRED_MODULES) {
        if (!files.some((file) => relative(file).startsWith(`node_modules/${name}/`))) {
            errors.push(`No ${name} binary in ${unpackedDir}: check build.files and build.asarUnpack in package.json.`);
        }
    }
    if (platform !== 'linux') return { errors, warnings, notes };

    const tooNew = [];
    for (const file of files) {
        const needs = elfVersionNeeds(fs.readFileSync(file));
        const newest = needs && newestVersions(needs);
        if (!newest?.GLIBC) {
            errors.push(`${relative(file)} is not a Linux binary that links glibc: package Linux on Linux, after \`npm ci\` there.`);
            continue;
        }
        const over = Object.entries(LINUX_BASELINE)
            .filter(([family, limit]) => newest[family] && compareVersions(newest[family], limit) > 0)
            .map(([family]) => `${family}_${newest[family]}`);
        if (over.length) tooNew.push(`  ${relative(file)} needs ${over.join(', ')}`);
        notes.push(`${relative(file)}: ${Object.entries(newest).map(([family, version]) => `${family}_${version}`).join(', ')}`);
    }
    if (tooNew.length) {
        const baseline = Object.entries(LINUX_BASELINE).map(([family, version]) => `${family}_${version}`).join(', ');
        const message = [
            `Native modules need a newer Linux than the package is for (${LINUX_BASELINE_NAME}: ${baseline}):`,
            ...tooNew,
            'Package Linux with `npm run dist:linux`, in the Debian 11 container the release workflow uses (Docker), where sqlite3 and node-pty are compiled against its glibc.',
            `To package for this machine's Linux and newer only, set ${SKIP_LINUX_CHECK_ENV}=1.`,
        ].join('\n');
        if (env[SKIP_LINUX_CHECK_ENV] === '1') warnings.push(message);
        else errors.push(message);
    }
    return { errors, warnings, notes };
}

/** @param {{ appOutDir: string, electronPlatformName: string, packager: { getResourcesDir(appOutDir: string): string } }} context */
export default async function afterPack(context) {
    const unpackedDir = path.join(context.packager.getResourcesDir(context.appOutDir), 'app.asar.unpacked');
    const { errors, warnings, notes } = checkPackedNatives({ platform: context.electronPlatformName, unpackedDir });
    for (const note of notes) console.log(`  • native module ${note}`);
    for (const warning of warnings) console.warn(`  ⚠ ${warning}`);
    if (errors.length) throw new Error(errors.join('\n'));
}
