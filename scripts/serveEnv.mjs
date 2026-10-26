import path from 'node:path';

// The backend environment of `npm run serve` (scripts/serve.mjs): the
// settings from the shell and .env win over these defaults. A blank DB_PATH
// (`DB_PATH=` in .env) counts as unset, as it does for the backend itself:
// the database then stays in the project root instead of dist-server/, which
// every build wipes.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @param {string} token
 * @returns {NodeJS.ProcessEnv}
 */
export function serveEnv(env, root, token) {
    return {
        ...env,
        SERVE_WEB: env.SERVE_WEB ?? '1',
        DB_PATH: env.DB_PATH?.trim() || path.join(root, 'shellmind.db'),
        SHELLMIND_AUTH_TOKEN: token,
    };
}
