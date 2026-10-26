import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveEnv } from '../../scripts/serveEnv.mjs';

const root = path.join(path.sep, 'srv', 'shellmind');

describe('npm run serve environment', () => {
    it('keeps the database in the project root by default, never in dist-server/', () => {
        expect(serveEnv({}, root, 't').DB_PATH).toBe(path.join(root, 'shellmind.db'));
    });

    it('treats a blank DB_PATH from .env as unset, as the backend does', () => {
        expect(serveEnv({ DB_PATH: '' }, root, 't').DB_PATH).toBe(path.join(root, 'shellmind.db'));
        expect(serveEnv({ DB_PATH: '   ' }, root, 't').DB_PATH).toBe(path.join(root, 'shellmind.db'));
    });

    it('lets the shell and .env choose the database and whether the web UI is served', () => {
        const env = serveEnv({ DB_PATH: '/data/shellmind.db', SERVE_WEB: '0', PORT: '4000' }, root, 'token-1');
        expect(env).toMatchObject({ DB_PATH: '/data/shellmind.db', SERVE_WEB: '0', PORT: '4000', SHELLMIND_AUTH_TOKEN: 'token-1' });
        expect(serveEnv({}, root, 't').SERVE_WEB).toBe('1');
    });
});
