// `node scripts/smoke-linux-distros.mjs <dir> [--distro image ...] [--prefix name]`:
// runs `smoke:packaged` on the Linux packages in <dir> (from `npm run
// dist:linux`) inside clean containers of the distributions they are for:
//   - the AppImage on each distribution, with the libraries a desktop has;
//   - the .deb on the Debian and Ubuntu ones, installed with apt, which pulls
//     its declared dependencies: they alone must be enough to start the app.
// The containers have no Node.js: the app's own runtime runs the smoke test
// (ELECTRON_RUN_AS_NODE). Each one is removed when it ends.
//   --distro <image>  instead of the default list (repeatable)
//   --prefix <name>   container name prefix (default shellmind-smoke)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export const DISTROS = ['debian:12', 'ubuntu:22.04', 'ubuntu:24.04', 'fedora:40'];

// What a desktop installation of each family has of Electron's libraries.
// Ubuntu 24.04 and Debian 13 renamed several of them (64-bit time_t: *t64).
const APT_LIBRARIES = 'libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnotify4 libnss3 libsecret-1-0 libxkbcommon0 libxshmfence1 libxss1 libxtst6 xdg-utils';
const DESKTOP_LIBRARIES = {
    apt: `apt-get update -qq && packages="" && for name in ${APT_LIBRARIES}; do if apt-cache show "\${name}t64" > /dev/null 2>&1; then packages="$packages \${name}t64"; else packages="$packages $name"; fi; done && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $packages > /dev/null`,
    dnf: 'dnf install -y -q alsa-lib at-spi2-atk cups-libs gtk3 libdrm libnotify libsecret libxkbcommon libxshmfence libXScrnSaver libXtst mesa-libgbm nss xdg-utils > /dev/null',
};
const family = (image) => (/^(fedora|rockylinux|almalinux|centos|amazonlinux)/.test(image) ? 'dnf' : 'apt');
const SMOKE = 'ELECTRON_RUN_AS_NODE=1';
// The smoke test and the modules it imports, mounted into /repo/scripts.
export const SMOKE_SCRIPTS = ['smoke-packaged.mjs', 'check-rdp-tls.mjs'];

/** The shell script of one check in a container (packages in /pkgs, the smoke test in /repo). */
export function checkScript(image, kind, file) {
    const app = kind === 'deb' ? `/opt/${pkg.build.productName}` : '/tmp/squashfs-root';
    const steps = kind === 'deb'
        ? ['apt-get update -qq', `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends /pkgs/${file} > /dev/null`]
        : [DESKTOP_LIBRARIES[family(image)], `cp /pkgs/${file} /tmp/app.AppImage`, 'chmod +x /tmp/app.AppImage', '(cd /tmp && ./app.AppImage --appimage-extract > /dev/null)'];
    return ['set -eu', ...steps, `${SMOKE} ${app}/${pkg.name} /repo/scripts/smoke-packaged.mjs ${app}`].join(' && ');
}

function parseArgs(argv) {
    const options = { dir: null, distros: [], prefix: 'shellmind-smoke' };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--distro' || arg === '--prefix') {
            const value = argv[++index];
            if (!value) throw new Error(`${arg} needs a value`);
            if (arg === '--distro') options.distros.push(value);
            else options.prefix = value;
        } else if (!arg.startsWith('--') && !options.dir) options.dir = arg;
        else throw new Error(`Unknown option ${arg}`);
    }
    if (!options.dir) throw new Error('Usage: node scripts/smoke-linux-distros.mjs <dir with the AppImage and .deb>');
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const dir = fs.realpathSync.native(path.resolve(options.dir));
    const files = fs.readdirSync(dir);
    const appImage = files.find((name) => name.endsWith('.AppImage'));
    const deb = files.find((name) => name.endsWith('.deb'));
    if (!appImage || !deb) throw new Error(`${dir} needs an AppImage and a .deb`);
    const distros = options.distros.length ? options.distros : DISTROS;
    const mounts = [
        '--mount', `type=bind,source=${dir},target=/pkgs,readonly`,
        '--mount', `type=bind,source=${fs.realpathSync.native(path.join(root, 'package.json'))},target=/repo/package.json,readonly`,
        ...SMOKE_SCRIPTS.flatMap((name) => ['--mount', `type=bind,source=${fs.realpathSync.native(fileURLToPath(new URL(name, import.meta.url)))},target=/repo/scripts/${name},readonly`]),
    ];
    const results = [];
    for (const image of distros) {
        for (const [kind, file] of [['AppImage', appImage], ...(family(image) === 'apt' ? [['deb', deb]] : [])]) {
            const name = `${options.prefix}-${image.replace(/[^a-z0-9]+/gi, '-')}-${kind.toLowerCase()}-${randomBytes(3).toString('hex')}`;
            console.log(`\n=== ${kind} on ${image} (${name})`);
            const result = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--name', name, ...mounts, image, 'bash', '-c', checkScript(image, kind, file)], { stdio: 'inherit' });
            results.push({ image, kind, ok: result.status === 0 });
        }
    }
    console.log('\nsmoke-linux-distros:');
    for (const { image, kind, ok } of results) console.log(`  ${ok ? 'passed' : 'FAILED'}  ${kind} on ${image}`);
    if (results.some((result) => !result.ok)) process.exit(1);
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`smoke-linux-distros: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
