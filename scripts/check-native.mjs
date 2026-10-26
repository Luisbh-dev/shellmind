// Runs after `npm install` / `npm ci` (package.json postinstall): checks that
// the native modules the backend needs load on this machine, and repairs the
// one failure known to happen.
//
// sqlite3's prebuilt Linux binary needs glibc 2.38 (Ubuntu 24.04, Debian 13 and
// later). On Debian 12, Ubuntu 22.04, RHEL/Rocky 9 or Amazon Linux 2023, npm
// installs it anyway, and the backend then dies loading it. Such a binary is
// rebuilt from source here, which needs python3, make and a C++ compiler
// (Debian/Ubuntu: `apt install python3 make g++`).
//
// --sqlite-from-source rebuilds sqlite3 from source in any case: the Linux
// app is packaged that way in a Debian 11 container (`npm run dist:linux`), so
// the binary it ships needs glibc 2.31 at most (Debian 11, Ubuntu 20.04 and
// later).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const forceSqliteBuild = process.argv.includes('--sqlite-from-source');

const say = (message) => console.log(`[shellmind] ${message}`);

// Loads `code` in a fresh Node process: a failed dlopen must not stay cached here.
function probe(code) {
    const result = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8' });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

// A binary that is there but cannot be loaded here (another libc, a missing
// or incompatible build), as opposed to a missing package.
export const UNLOADABLE = /GLIBC_|GLIBCXX_|ERR_DLOPEN_FAILED|Could not locate the bindings file|invalid ELF header|wrong ELF class|cannot open shared object file|was compiled against a different Node\.js version/;

function firstErrorLine(output) {
    return output.split('\n').find((line) => /Error/.test(line))?.trim() ?? output.split('\n')[0];
}

// node-gyp of the project (sqlite3 depends on it), else the one npm bundles.
function nodeGyp() {
    try {
        return require.resolve('node-gyp/bin/node-gyp.js');
    } catch {
        const npmCli = process.env.npm_execpath;
        const bundled = npmCli && path.join(path.dirname(npmCli), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
        if (bundled && fs.existsSync(bundled)) return bundled;
        return null;
    }
}

function buildSqliteFromSource() {
    const gyp = nodeGyp();
    if (!gyp) {
        say('node-gyp was not found, so sqlite3 cannot be built from source.');
        return false;
    }
    const dir = path.dirname(require.resolve('sqlite3/package.json'));
    say('Building sqlite3 from source (a few minutes)...');
    // The project's node-gyp directly: no npm configuration involved, which
    // npm 12 rejects for --build-from-source.
    const result = spawnSync(process.execPath, [gyp, 'rebuild'], { cwd: dir, stdio: 'inherit' });
    return result.status === 0;
}

function checkSqlite() {
    const load = "require('sqlite3')";
    let result = probe(load);
    if (result.ok && !forceSqliteBuild) return true;
    if (!result.ok) {
        if (!UNLOADABLE.test(result.output)) {
            say(`sqlite3 does not load: ${firstErrorLine(result.output)}`);
            return false;
        }
        say(`The installed sqlite3 binary does not load on this system (${firstErrorLine(result.output)}).`);
    }
    if (buildSqliteFromSource()) {
        result = probe(load);
        if (result.ok) {
            say('sqlite3 was built from source and loads.');
            return true;
        }
    }
    say('sqlite3 could not be built. Install python3, make and a C++ compiler (Debian/Ubuntu: `apt install python3 make g++`), then run `npm run postinstall` again.');
    return false;
}

function main() {
    if (!checkSqlite()) process.exit(1);

    // Local terminals; the backend reports them unavailable when this fails.
    const pty = probe("require('node-pty')");
    if (!pty.ok) say(`node-pty does not load, so local terminals will not work: ${firstErrorLine(pty.output)}`);

    // Optional: without it ssh2 creates a cipher per SSH packet through Node's
    // crypto API, which costs noticeably more CPU on busy terminals.
    const crypto = probe("process.stdout.write(String(require('ssh2/lib/protocol/crypto.js').bindingAvailable))");
    if (crypto.ok && crypto.output !== 'true') {
        say("ssh2's optional native crypto binding is not built (it needs a C++ toolchain): SSH works, with more CPU per packet. After installing build tools, run `npm rebuild ssh2`.");
    }
}

// Run by npm; imported by its tests. Both paths are real paths (8.3 short
// names and symlinks resolved), as Node resolves the entry module.
const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) main();
