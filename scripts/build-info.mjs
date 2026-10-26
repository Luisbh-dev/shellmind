// The last step of `npm run build`: records which commit the build comes from
// in dist-electron/build-info.json, which every package ships in app.asar.
// scripts/smoke-packaged.mjs compares it with the checkout it runs from, so a
// package built before the latest commits (an installer left over from an
// earlier build) fails its check instead of reaching a release.
//   SHELLMIND_BUILD_COMMIT  the commit, where the source has no .git (the
//                           Linux build container gets a `git archive` of it)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_INFO_FILE = 'dist-electron/build-info.json';

/** @param {string[]} args @returns {string | null} git's output, or null without git or a repository */
function git(args) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * @param {{ version: string, env: Record<string, string | undefined>, git: (args: string[]) => string | null }} source
 * @returns {{ version: string, commit: string | null, dirty: boolean }}
 *   dirty: tracked files differed from the commit (a local build of changes)
 */
export function buildInfo({ version, env, git: runGit }) {
    const given = env.SHELLMIND_BUILD_COMMIT?.trim();
    if (given) {
        if (!/^[0-9a-f]{40}$/.test(given)) throw new Error(`SHELLMIND_BUILD_COMMIT is not a full commit id: ${given}`);
        return { version, commit: given, dirty: false };
    }
    const commit = runGit(['rev-parse', 'HEAD']);
    if (!commit) return { version, commit: null, dirty: false };
    return { version, commit, dirty: Boolean(runGit(['status', '--porcelain', '--untracked-files=no'])) };
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const info = buildInfo({ version: pkg.version, env: process.env, git });
        const file = path.join(root, BUILD_INFO_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
        console.log(`[build-info] ${pkg.version} from ${info.commit ?? 'an unknown commit'}${info.dirty ? ' with uncommitted changes' : ''}`);
    } catch (error) {
        console.error(`[build-info] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
