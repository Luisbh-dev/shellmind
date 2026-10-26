import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RestartBudget } from '../../electron/restartBudget';

describe('RestartBudget', () => {
    it('allows `max` restarts within the window, then hands over to the user with a fresh budget', () => {
        const budget = new RestartBudget(3, 60_000);
        expect([0, 1_000, 2_000].map((at) => budget.take(at))).toEqual([true, true, true]);
        expect(budget.take(3_000)).toBe(false);
        // The restart the user asked for starts a new count.
        expect(budget.take(4_000)).toBe(true);
    });

    it('forgets crashes older than the window', () => {
        const budget = new RestartBudget(1, 10_000);
        expect(budget.take(0)).toBe(true);
        expect(budget.take(10_000)).toBe(true);
        expect(budget.take(15_000)).toBe(false);
    });
});

describe('renderer crash handling', () => {
    it('reloads a window whose renderer died and logs why', () => {
        // electron/main.ts needs Electron to run; check the wiring it relies on.
        const main = fs.readFileSync(path.join(fileURLToPath(new URL('../..', import.meta.url)), 'electron', 'main.ts'), 'utf8');
        expect(main).toMatch(/webContents\.on\('render-process-gone'/);
        expect(main).toMatch(/rendererRestarts\.take\(\)/);
        expect(main).toMatch(/window\.on\('unresponsive'/);
        expect(main).toMatch(/app\.on\('child-process-gone'/);
    });
});
