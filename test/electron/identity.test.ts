import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_USER_MODEL_ID, devUserDataDir } from '../../electron/identity';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    name: string;
    productName?: string;
    build: { appId: string };
};

describe('desktop app identity', () => {
    it('runs under the AppUserModelID the installer gives its shortcuts', () => {
        expect(APP_USER_MODEL_ID).toBe(pkg.build.appId);
    });

    it('gives development runs a data folder (and so a single-instance lock) of their own', () => {
        const appData = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming');
        // The installed app's folder: app.getName() is the package name, as
        // there is no top-level productName (build.productName only names the exe).
        expect(pkg.productName).toBeUndefined();
        const installed = path.join(appData, pkg.name);
        expect(devUserDataDir(appData)).not.toBe(installed);
        expect(path.dirname(devUserDataDir(appData))).toBe(appData);
    });

    it('applies both before the single-instance lock is taken', () => {
        const main = fs.readFileSync(path.join(repoRoot, 'electron', 'main.ts'), 'utf8');
        const lock = main.indexOf('requestSingleInstanceLock()');
        expect(lock).toBeGreaterThan(0);
        for (const call of ["app.setPath('userData', devUserDataDir(", 'app.setAppUserModelId(APP_USER_MODEL_ID)']) {
            const at = main.indexOf(call);
            expect(at, call).toBeGreaterThan(0);
            expect(at, call).toBeLessThan(lock);
        }
    });
});
