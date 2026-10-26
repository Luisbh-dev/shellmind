// `npm run dist:linux [-- options]`: builds the Linux packages (AppImage and
// .deb, x64) in Docker, on Debian 11 (build/linux-builder.Dockerfile), so
// that they run on Debian 11+, Ubuntu 20.04+, RHEL 9+ and Fedora whatever the
// machine that builds them; the release workflow builds them the same way.
// The container gets the committed HEAD of this checkout (git archive):
// uncommitted changes are not part of the build. It installs its own
// node_modules, builds, packages and smoke-tests both packages
// (scripts/dist-linux-container.sh).
//   --out <dir>     where the packages go (default release/); must hold no
//                   AppImage or .deb yet
//   --image <name>  the builder image (default shellmind-linux-builder)
//   --name <name>   the build container (removed when it ends)
// Works from Windows, macOS and Linux with Docker (an x64 engine, or one that
// emulates linux/amd64).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const DOCKERFILE = path.join(root, 'build', 'linux-builder.Dockerfile');
const PLATFORM = 'linux/amd64';

/** @param {string[]} argv */
export function parseArgs(argv) {
    const options = { out: null, image: 'shellmind-linux-builder', name: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const key = { '--out': 'out', '--image': 'image', '--name': 'name' }[arg];
        const value = argv[index + 1];
        if (!key) throw new Error(`Unknown option ${arg}`);
        if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
        options[key] = value;
        index += 1;
    }
    return options;
}

/**
 * The docker run arguments of a build (paths as Docker on this machine takes them).
 * `commit`: the archived commit, which the packages record (scripts/build-info.mjs)
 * and the container's smoke test expects: the archive has no .git.
 * @param {{ image: string, name?: string | null, source: string, out: string, uid?: number, gid?: number, commit: string }} options
 */
export function runArgs({ image, name, source, out, uid, gid, commit }) {
    return [
        'run', '--rm', '--platform', PLATFORM,
        ...(name ? ['--name', name] : []),
        '--mount', `type=bind,source=${source},target=/src.tar,readonly`,
        '--mount', `type=bind,source=${out},target=/out`,
        '-e', `SHELLMIND_BUILD_COMMIT=${commit}`,
        ...(uid === undefined ? [] : ['-e', `HOST_UID=${uid}`, '-e', `HOST_GID=${gid}`]),
        image,
        'bash', '-c', 'mkdir -p /work && tar -x -C /work -f /src.tar && exec bash /work/scripts/dist-linux-container.sh',
    ];
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.error) throw new Error(`${command}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${command} ${args[0]} exited with ${result.status ?? result.signal}`);
    return result;
}

function git(args) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    // Docker Desktop shares long paths, not 8.3 short names (C:\Users\ADMINI~1).
    const out = path.resolve(options.out ?? path.join(root, pkg.build.directories.output));
    fs.mkdirSync(out, { recursive: true });
    const outDir = fs.realpathSync.native(out);
    const stale = fs.readdirSync(outDir).filter((name) => /\.(AppImage|deb)$/.test(name));
    if (stale.length) throw new Error(`${outDir} already holds ${stale.join(', ')}: remove them or pick another --out`);

    const commit = git(['rev-parse', 'HEAD']);
    const head = commit.slice(0, 7);
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
        console.warn(`[dist:linux] Uncommitted changes are not part of the build: it packages HEAD (${head}).`);
    }
    const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-linux-src-')));
    const source = path.join(work, 'source.tar');
    try {
        git(['archive', '--format=tar', '-o', source, 'HEAD']);
        console.log(`[dist:linux] Building ${pkg.name} ${pkg.version} (${head}) in ${options.image} into ${outDir}`);
        run('docker', ['build', '--platform', PLATFORM, '-t', options.image, '-'], { input: fs.readFileSync(DOCKERFILE), stdio: ['pipe', 'inherit', 'inherit'] });
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
        run('docker', runArgs({ image: options.image, name: options.name, source, out: outDir, uid, gid, commit }));
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(outDir).filter((file) => /\.(AppImage|deb)$/.test(file))) {
        console.log(`[dist:linux] ${path.join(outDir, name)}`);
    }
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`[dist:linux] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
