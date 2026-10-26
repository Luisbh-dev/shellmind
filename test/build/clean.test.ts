import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `npm run clean` (first step of `npm run build`) in a scratch project.
const script = fileURLToPath(new URL('../../scripts/clean.mjs', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-clean-'));
    dirs.push(dir);
    for (const file of files) {
        fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), 'x');
    }
    return dir;
}

const clean = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });

describe('npm run clean', () => {
    it('removes the build output', () => {
        const dir = project(['dist/index.html', 'dist-server/server.js', 'dist-electron/main.js', 'coverage/index.html', 'src/main.tsx']);
        expect(clean(dir).status).toBe(0);
        expect(fs.readdirSync(dir)).toEqual(['src']);
    });

    it('refuses to delete a database and its key that `node dist-server/server.js` left in the build output', () => {
        const dir = project(['dist-server/server.js', 'dist-server/shellmind.db', 'dist-server/shellmind.db-wal', 'dist-server/shellmind.key', 'dist/index.html']);
        const result = clean(dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(path.join('dist-server', 'shellmind.db'));
        expect(result.stderr).toContain(path.join('dist-server', 'shellmind.key'));
        expect(result.stderr).toContain('DB_PATH');
        // Nothing removed, not even the rest of the output.
        for (const file of ['dist-server/shellmind.db', 'dist-server/shellmind.db-wal', 'dist-server/shellmind.key', 'dist/index.html']) {
            expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
        }
    });
});
