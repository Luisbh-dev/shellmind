import { describe, expect, it } from 'vitest';
import { readWorkflow, setting, steps } from '../helpers/workflow';

// The CI workflow's run control and its packaging jobs. Its GitHub
// expressions are evaluated for each kind of run.

const { text: workflow, block } = readWorkflow('ci.yml');

type Context = { github: { workflow: string; event_name: string; ref: string; event: { pull_request?: { number: number } } } };

// GitHub expressions of the forms used here: context paths, 'strings', == and ||.
function evaluate(expression: string, context: Context): unknown {
    const term = (text: string): unknown => {
        const literal = /^'(.*)'$/.exec(text);
        if (literal) return literal[1];
        return text.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key] ?? null, context);
    };
    let result: unknown = null;
    for (const part of expression.split('||').map((text) => text.trim())) {
        const [left, right] = part.split('==').map((text) => text.trim());
        result = right === undefined ? term(left) : term(left) === term(right);
        if (result) return result;
    }
    return result;
}

function interpolate(value: string, context: Context): unknown {
    const whole = /^\$\{\{(.+)\}\}$/.exec(value);
    if (whole) return evaluate(whole[1].trim(), context);
    if (value === 'true' || value === 'false') return value === 'true';
    return value.replace(/\$\{\{(.+?)\}\}/g, (_, expression: string) => String(evaluate(expression.trim(), context)));
}

const run = (event_name: string, ref = 'refs/heads/main', pull_request?: { number: number }): Context => ({
    github: { workflow: 'CI', event_name, ref, event: { pull_request } },
});
const concurrency = block('concurrency', 0);
const groupOf = (context: Context) => interpolate(setting(concurrency, 'group'), context);
const cancels = (context: Context) => interpolate(setting(concurrency, 'cancel-in-progress'), context);

describe('CI run control', () => {
    it('never lets a push to main cancel or replace the weekly run, nor the other way round', () => {
        const push = run('push');
        const weekly = run('schedule');
        const manual = run('workflow_dispatch');
        expect(new Set([groupOf(push), groupOf(weekly), groupOf(manual)]).size).toBe(3);
        for (const context of [push, weekly, manual]) expect(cancels(context)).toBe(false);
    });

    it('runs a pull request once, a newer push cancelling the older run', () => {
        const first = run('pull_request', 'refs/pull/7/merge', { number: 7 });
        const other = run('pull_request', 'refs/pull/8/merge', { number: 8 });
        expect(groupOf(first)).toBe(groupOf(run('pull_request', 'refs/pull/7/merge', { number: 7 })));
        expect(groupOf(first)).not.toBe(groupOf(other));
        expect(cancels(first)).toBe(true);
        expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/m);
    });
});

describe('CI packages', () => {
    it('packages the Linux AppImage and deb in the Debian 11 container, as releases are, and keeps them', () => {
        const job = block('package-linux', 2);
        // The container is the build: the job itself runs on the runner.
        expect(job).not.toMatch(/^ {4}container:/m);
        const run = steps(job).map((step) => step.text).filter((text) => text.includes('run: '));
        expect(run).toEqual([expect.stringContaining('run: node scripts/dist-linux-docker.mjs --out release')]);
        const upload = job.slice(job.indexOf('actions/upload-artifact@'));
        expect(upload).toMatch(/path: \|\n {12}release\/\*\.AppImage\n {12}release\/\*\.deb\n/);
        expect(setting(upload, 'if-no-files-found')).toBe('error');
    });

    it('packages Windows and macOS with scripts/dist.mjs (the Mac ad hoc signed) and smoke-tests them', () => {
        for (const [name, platform] of [['package-windows', 'win'], ['package-macos', 'mac']]) {
            const job = block(name, 2);
            expect(job).toContain(`run: node scripts/dist.mjs --${platform} --dir`);
            expect(job.indexOf('npm run smoke:packaged')).toBeGreaterThan(job.indexOf('scripts/dist.mjs'));
            expect(job).not.toContain('npx electron-builder');
        }
        expect(setting(block('package-macos', 2), 'CSC_IDENTITY_AUTO_DISCOVERY')).toBe('"false"');
    });
});
