import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINUX_BASELINE } from '../../scripts/after-pack.mjs';
import { parseArgs, runArgs } from '../../scripts/dist-linux-docker.mjs';
import { checkScript, DISTROS } from '../../scripts/smoke-linux-distros.mjs';

// `npm run dist:linux`: the Linux packages are built in a Debian 11 container
// from the committed tree, so that what they link stays within the baseline
// the afterPack check holds them to.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dockerfile = fs.readFileSync(path.join(repoRoot, 'build', 'linux-builder.Dockerfile'), 'utf8');
const container = fs.readFileSync(path.join(repoRoot, 'scripts', 'dist-linux-container.sh'), 'utf8');

describe('Linux build container', () => {
    it('is Debian 11, whose glibc is the baseline of the packages', () => {
        expect(dockerfile).toMatch(/^ARG BASE_IMAGE=node:24-bullseye$/m);
        expect(dockerfile).toMatch(/^FROM \$\{BASE_IMAGE\}$/m);
        // Debian 11: glibc 2.31, GCC 10.2 (GLIBCXX_3.4.28, CXXABI_1.3.12).
        expect(LINUX_BASELINE).toEqual({ GLIBC: '2.31', GLIBCXX: '3.4.28', CXXABI: '1.3.12' });
    });

    it('installs its own node_modules and compiles sqlite3 before packaging, then smoke-tests both packages', () => {
        const order = ['npm ci', 'node scripts/check-native.mjs --sqlite-from-source', 'npm run build', 'node scripts/dist.mjs --linux --x64 --out /out', 'node scripts/smoke-packaged.mjs "$package"'];
        const positions = order.map((command) => container.indexOf(command));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        expect(container).toMatch(/^set -euo pipefail$/m);
    });
});

describe('npm run dist:linux', () => {
    it('takes an output folder, an image and a container name', () => {
        expect(parseArgs([])).toEqual({ out: null, image: 'shellmind-linux-builder', name: null });
        expect(parseArgs(['--out', 'pkg', '--image', 'img', '--name', 'box'])).toEqual({ out: 'pkg', image: 'img', name: 'box' });
        expect(() => parseArgs(['--out'])).toThrow(/--out needs a value/);
        expect(() => parseArgs(['--arch', 'arm64'])).toThrow(/Unknown option --arch/);
    });

    it('runs the x64 container on the source archive (read-only) and the output folder, as the calling user', () => {
        const args = runArgs({ image: 'img', name: 'box', source: '/tmp/s/source.tar', out: '/home/me/release', uid: 1000, gid: 1001, commit: 'e'.repeat(40) });
        expect(args.slice(0, 6)).toEqual(['run', '--rm', '--platform', 'linux/amd64', '--name', 'box']);
        expect(args).toContain('type=bind,source=/tmp/s/source.tar,target=/src.tar,readonly');
        expect(args).toContain('type=bind,source=/home/me/release,target=/out');
        expect(args).toEqual(expect.arrayContaining(['HOST_UID=1000', 'HOST_GID=1001']));
        // The archive has no .git: the packages record, and the container's
        // smoke test expects, the commit it was made from.
        expect(runArgs({ image: 'img', name: null, source: 's', out: 'o', commit: 'f'.repeat(40) })).toEqual(expect.arrayContaining(['-e', `SHELLMIND_BUILD_COMMIT=${'f'.repeat(40)}`]));
        expect(args.at(-1)).toBe('mkdir -p /work && tar -x -C /work -f /src.tar && exec bash /work/scripts/dist-linux-container.sh');
        // Windows has no user ids to hand over; Docker Desktop's files belong to the user anyway.
        const windows = runArgs({ image: 'img', name: null, source: 'C:\\t\\source.tar', out: 'C:\\out', uid: undefined, gid: undefined, commit: 'e'.repeat(40) });
        expect(windows.join(' ')).not.toContain('HOST_UID');
        expect(windows).not.toContain('--name');
    });
});

describe('Linux packages on other distributions', () => {
    it('covers the distributions the packages are for', () => {
        expect(DISTROS).toEqual(expect.arrayContaining(['debian:12', 'ubuntu:22.04', 'fedora:40']));
    });

    it('installs the deb with apt and nothing else, so that its declared dependencies must be enough', () => {
        const script = checkScript('ubuntu:22.04', 'deb', 'shellmind_1.0.0_amd64.deb');
        expect(script).toContain('apt-get install -y -qq --no-install-recommends /pkgs/shellmind_1.0.0_amd64.deb');
        expect(script).not.toContain('libgtk-3-0');
        expect(script).toMatch(/&& ELECTRON_RUN_AS_NODE=1 \/opt\/ShellMind\/shellmind \/repo\/scripts\/smoke-packaged\.mjs \/opt\/ShellMind$/);
    });

    it('runs the extracted AppImage with the libraries of a desktop of that family', () => {
        const fedora = checkScript('fedora:40', 'AppImage', 'ShellMind-1.0.0-x86_64.AppImage');
        expect(fedora).toContain('dnf install -y -q');
        expect(fedora).toContain('./app.AppImage --appimage-extract');
        expect(fedora).toMatch(/ELECTRON_RUN_AS_NODE=1 \/tmp\/squashfs-root\/shellmind \/repo\/scripts\/smoke-packaged\.mjs \/tmp\/squashfs-root$/);
        expect(checkScript('debian:12', 'AppImage', 'x.AppImage')).toContain('apt-get install');
    });
});
