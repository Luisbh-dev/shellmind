import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, mergeConfig, searchForWorkspaceRoot } from 'vite';
import appConfig from '../../vite.config';

const root = process.cwd();

// The app's own Vite config, with the pre-bundled dependencies kept in the
// run's temp directory: node_modules/.vite belongs to the developer's
// `npm start` (a worktree may share that node_modules), and rewriting it under
// a running dev server breaks its open pages. A node_modules linked from
// elsewhere (a git worktree's) may be served too.
export default defineConfig((env) => mergeConfig(appConfig(env), {
    cacheDir: process.env.SHELLMIND_E2E_UI_VITE_CACHE || undefined,
    clearScreen: false,
    server: {
        fs: { allow: [searchForWorkspaceRoot(root), fs.realpathSync(path.join(root, 'node_modules'))] },
    },
}));
