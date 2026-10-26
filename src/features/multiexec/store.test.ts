import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STRATEGY, emptyCounts, type MultiExecJobInfo, type MultiExecResult, type MultiExecServerRun } from '@shared/multiexec';
import type { ServerSummary } from '@shared/types';
import { setLanguage, t } from '@/i18n';
import { ApiError, notifyUnauthorized } from '@/lib/api';
import { exportFileName } from '@/lib/download';
import { composerFromDraft, composerFromJob, deriveComposer, emptyComposer } from './composerState';
import { controlErrorText, serverErrorText, startErrorText } from './errors';
import { formatDuration, jobToCsv, jobToJson, jobToText } from './export';
import { applyEvent, isJobActive, mayHaveRun, REQUEST_KEEP_MS, resetMultiExecStore, retryServers, startedView, summaryOf, useMultiExecStore, type JobView } from './store';
import { DEFAULT_STRATEGY_FORM, describePlan, formFromStrategy, strategyFromForm } from './strategy';

afterEach(() => setLanguage('system'));

const targets = [
    { serverId: 1, name: 'alpha', host: '10.0.0.1', type: 'linux' as const },
    { serverId: 2, name: 'bravo', host: '10.0.0.2', type: 'windows' as const },
    { serverId: 3, name: 'charlie', host: '10.0.0.3', type: 'linux' as const },
];

function info(overrides: Partial<MultiExecJobInfo> = {}): MultiExecJobInfo {
    return {
        id: 'job-1',
        command: 'uptime',
        masked: false,
        template: null,
        templateMasked: false,
        variables: null,
        secretVariables: [],
        snippet: null,
        timeoutSec: 60,
        strategy: DEFAULT_STRATEGY,
        status: 'running',
        pause: null,
        stopReason: null,
        batch: null,
        batches: 1,
        nextBatchAt: null,
        danger: null,
        rerunOf: null,
        createdAt: 1_000,
        finishedAt: null,
        total: 3,
        counts: emptyCounts(),
        ...overrides
    };
}

const result = (serverId: number, overrides: Partial<MultiExecResult>): MultiExecResult => ({
    serverId, status: 'ok', exitCode: 0, signal: null, error: null, errorCode: null, startedAt: 2_000, finishedAt: 2_500, durationMs: 500, truncated: false,
    outputHash: 'h1', normalizedHash: 'n1', ...overrides,
});

function finished(): JobView {
    let view = startedView(info({ id: 'r9' }), targets);
    view = applyEvent(view, { type: 'output', serverId: 1, stream: 'stdout', data: 'fine\n' });
    view = applyEvent(view, { type: 'result', result: result(1, {}) });
    view = applyEvent(view, { type: 'result', result: result(2, { status: 'failed', exitCode: 2, durationMs: 61_500 }) });
    view = applyEvent(view, { type: 'output', serverId: 3, stream: 'stderr', data: 'boom\n' });
    view = applyEvent(view, { type: 'result', result: result(3, { status: 'failed', exitCode: null, error: 'Auth failed. Server accepts: publickey', errorCode: 'AUTH_FAILED', truncated: true, outputHash: null }) });
    return applyEvent(view, { type: 'job', job: info({ id: 'r9', status: 'done', finishedAt: 5_000 }) });
}

describe('applyEvent', () => {
    it('follows a job from its start to its end', () => {
        let view = startedView(info({ strategy: { ...DEFAULT_STRATEGY, canary: { count: 1, onSuccess: 'pause' } }, batches: 2 }), targets);
        expect(view.servers.map((server) => [server.name, server.status, server.batch])).toEqual([['alpha', 'queued', 0], ['bravo', 'queued', 1], ['charlie', 'queued', 1]]);
        expect(isJobActive(view)).toBe(true);

        view = applyEvent(view, { type: 'running', serverId: 1, startedAt: 2_000 });
        view = applyEvent(view, { type: 'output', serverId: 1, stream: 'stdout', data: 'up 3 days\n' });
        view = applyEvent(view, { type: 'output', serverId: 1, stream: 'stderr', data: 'warn\n' });
        view = applyEvent(view, { type: 'output', serverId: 1, stream: 'stdout', data: 'more\n' });
        expect(view.servers[0]).toMatchObject({ status: 'running', startedAt: 2_000, stdout: 'up 3 days\nmore\n', stderr: 'warn\n' });

        view = applyEvent(view, { type: 'result', result: result(1, {}) });
        view = applyEvent(view, { type: 'job', job: info({ status: 'paused', pause: { reason: 'canary', since: 3_000, expiresAt: 9_000 } }) });
        expect(view.info.pause?.reason).toBe('canary');
        view = applyEvent(view, { type: 'result', result: result(2, { status: 'failed', exitCode: 1 }) });
        view = applyEvent(view, { type: 'result', result: result(3, { status: 'timeout', exitCode: null, error: 'too slow' }) });
        view = applyEvent(view, { type: 'ping' });
        view = applyEvent(view, { type: 'job', job: info({ status: 'done', finishedAt: 9_000 }) });
        expect(isJobActive(view)).toBe(false);
        expect(summaryOf(view).counts).toMatchObject({ ok: 1, failed: 1, timeout: 1, queued: 0 });
        expect(retryServers(view.servers).map((server) => server.serverId)).toEqual([2, 3]);
    });

    // CR-01: after a crash the job history says where the command may have
    // run; running it there again by default would run a useradd or a
    // patch-and-reboot twice.
    it('leaves out of "run again" the servers where the command may have run', () => {
        const servers = startedView(info(), [...targets, { serverId: 4, name: 'four', host: '10.0.0.4', type: 'linux' }]).servers.map((server): MultiExecServerRun => ({ ...server, status: 'cancelled' }));
        servers[0] = { ...servers[0], startedAt: 1_000, errorCode: 'INTERRUPTED' };
        servers[1] = { ...servers[1], startedAt: 1_000 };
        servers[2] = { ...servers[2], status: 'skipped' };
        expect(servers.filter(mayHaveRun).map((server) => server.serverId)).toEqual([1, 2]);
        expect(retryServers(servers).map((server) => server.serverId)).toEqual([3, 4]);
    });

    it('replaces what it knows with a snapshot', () => {
        const view = startedView(info(), targets);
        const snapshot = applyEvent(view, {
            type: 'snapshot',
            job: { ...info({ status: 'done' }), servers: view.servers.map((server) => ({ ...server, status: 'ok' as const, stdout: 'x' })) },
        });
        expect(snapshot.loaded).toBe(true);
        expect(snapshot.servers.every((server) => server.status === 'ok' && server.stdout === 'x')).toBe(true);
    });
});

describe('error texts', () => {
    it('explains server failures by their code, with the technical detail where it helps', () => {
        expect(serverErrorText({ error: null, errorCode: null, signal: null }, 30, t)).toBeNull();
        expect(serverErrorText({ error: 'odd failure', errorCode: null, signal: null }, 30, t)).toEqual({ message: 'odd failure', detail: null });
        expect(serverErrorText({ error: 'connect ECONNREFUSED 10.0.0.1:22', errorCode: 'CONNECTION_REFUSED', signal: null }, 30, t))
            .toEqual({ message: 'The server refused the connection. Is SSH running on that port?', detail: 'connect ECONNREFUSED 10.0.0.1:22' });
        setLanguage('es');
        expect(serverErrorText({ error: null, errorCode: 'INTERRUPTED', signal: null }, 5, t)?.message).toBe('ShellMind se cerró (o su backend se detuvo) mientras el comando estaba en curso: puede haberse ejecutado entero o en parte.');
    });

    it('explains why the backend refused a job or a control', () => {
        const refused = (status: number, body: unknown) => new ApiError(status, 'raw backend text', body);
        expect(startErrorText(refused(429, { code: 'MULTIEXEC_BUSY' }), targets, t)).toBe('Too many multi-exec jobs are running right now. Wait for one to finish and try again.');
        expect(startErrorText(refused(400, { code: 'INVALID_MULTIEXEC', details: { missing: [2, 9] } }), targets, t))
            .toBe('These servers no longer exist: bravo, #9. Reopen multi-exec to reload the list.');
        expect(startErrorText(refused(400, { code: 'INVALID_MULTIEXEC', details: { missingVariables: ['dir', 'host'] } }), targets, t)).toBe('Fill in: dir, host');
        expect(startErrorText(refused(409, { code: 'DANGEROUS_COMMAND' }), targets, t)).toMatch(/destructive command/);
        expect(startErrorText(refused(400, { code: 'INVALID_MULTIEXEC' }), targets, t)).toBe('The backend did not accept the job: raw backend text');
        expect(startErrorText(new Error('offline'), targets, t)).toBe('offline');
        expect(controlErrorText(refused(409, { code: 'MULTIEXEC_JOB_FINISHED' }), t)).toBe('The job has already finished.');
    });
});

describe('exports', () => {
    it('exports every result with its output as JSON', () => {
        const json = JSON.parse(jobToJson(finished()));
        expect(json).toMatchObject({ jobId: 'r9', command: 'uptime', status: 'done', createdAt: new Date(1_000).toISOString(), finishedAt: new Date(5_000).toISOString() });
        expect(json.results).toEqual([
            expect.objectContaining({ server: 'alpha', host: '10.0.0.1', batch: 1, status: 'ok', exitCode: 0, stdout: 'fine\n', stderr: '' }),
            expect.objectContaining({ server: 'bravo', status: 'failed', exitCode: 2 }),
            expect.objectContaining({ server: 'charlie', status: 'failed', errorCode: 'AUTH_FAILED', truncated: true, stderr: 'boom\n' }),
        ]);
    });

    it('exports one CSV row per server, defusing formulas', () => {
        let view = finished();
        view = applyEvent(view, { type: 'output', serverId: 2, stream: 'stdout', data: '=HYPERLINK("x")\n' });
        const csv = jobToCsv(view);
        expect(csv.startsWith('﻿server_id,server,host,type,batch,status,exit_code,duration_ms,error,started_at,finished_at,stdout,stderr\r\n')).toBe(true);
        const rows = csv.trim().split('\r\n');
        expect(rows).toHaveLength(4);
        expect(rows[1]).toMatch(/^1,alpha,10\.0\.0\.1,linux,1,ok,0,500,/);
        expect(csv).toContain(`"'=HYPERLINK(""x"")\n"`);
    });

    it('exports a readable text report', () => {
        const text = jobToText(finished(), t);
        expect(text).toContain('Status: Done');
        expect(text).toContain('=== alpha (10.0.0.1) — OK, exit 0, 500 ms ===\n--- stdout ---\nfine\n');
        expect(text).toContain('=== bravo (10.0.0.2) — Failed, exit 2, 1 min 2 s ===');
        expect(text).toContain('Error: Authentication failed: the server rejected the saved credentials. (Auth failed. Server accepts: publickey)\n--- stderr ---\nboom\n[Output truncated');
    });

    it('formats durations and file names', () => {
        expect(formatDuration(null)).toBe('—');
        expect(formatDuration(850)).toBe('850 ms');
        expect(formatDuration(12_340)).toBe('12.3 s');
        expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe('3 h 5 min');
        expect(exportFileName('shellmind-multiexec', new Date(2026, 9, 3, 7, 5, 9).getTime())).toBe('shellmind-multiexec-20261003-070509');
    });
});

describe('rollout settings', () => {
    it('turns the form into a strategy and explains the plan', () => {
        const form = { ...DEFAULT_STRATEGY_FORM, mode: 'rolling' as const, batchSize: '25', batchUnit: 'percent' as const, pauseSec: '30', canary: true, canaryCount: '2', failureLimit: true, failureCount: '3', failurePercent: '10' };
        const check = strategyFromForm(form, 40, t);
        expect(check.problems).toEqual([]);
        expect(check.strategy).toEqual({
            concurrency: 5, batch: { size: 25, unit: 'percent' }, pauseSec: 30, canary: { count: 2, onSuccess: 'pause' }, failureLimit: { count: 3, percent: 10 },
        });
        expect(describePlan(check.strategy!, 40, t)).toEqual([
            'Canary: 2 servers first, then wait for your approval.',
            '4 batches of up to 10 servers, up to 5 at a time. 30 s between batches.',
            'Stops after 3 failures or 10 % of the servers, whichever comes first.',
        ]);
        expect(formFromStrategy(check.strategy!)).toMatchObject({ mode: 'rolling', batchSize: '25', canary: true, canaryCount: '2', failureCount: '3', failurePercent: '10' });

        expect(describePlan({ ...DEFAULT_STRATEGY, failureLimit: { count: 1, percent: null } }, 12, t)).toEqual(['All 12 servers, up to 5 at a time.', 'Stops at the first failure.']);
        // CR-02: a canary that goes on by itself is watched for the pause.
        expect(describePlan({ ...check.strategy!, canary: { count: 2, onSuccess: 'continue' }, failureLimit: null }, 40, t)[0]).toBe('Canary: 2 servers first, then wait 30 s and continue if they all succeed.');
        expect(describePlan({ ...check.strategy!, pauseSec: 0, canary: { count: 2, onSuccess: 'continue' }, failureLimit: null }, 40, t)[0]).toBe('Canary: 2 servers first, then continue if they all succeed.');
    });

    it('says what is wrong with the settings', () => {
        const check = strategyFromForm({ ...DEFAULT_STRATEGY_FORM, mode: 'rolling', batchSize: '0', concurrency: '30', canary: true, canaryCount: '5', failureLimit: true, failureCount: '', failurePercent: '' }, 5, t);
        expect(check.strategy).toBeNull();
        expect([...check.invalid].sort()).toEqual(['batchSize', 'canaryCount', 'concurrency', 'failureCount']);
        expect(strategyFromForm({ ...DEFAULT_STRATEGY_FORM, canary: true }, 1, t).problems).toEqual(['A canary needs at least two servers selected.']);
    });
});

describe('requests kept in memory', () => {
    afterEach(() => {
        resetMultiExecStore();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('drops the request (and its secret values) of a finished job after a while, and every one on sign-out', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [info({ id: 'done-1', status: 'done', finishedAt: 2_000 })] }), {
            headers: { 'Content-Type': 'application/json' },
        })));
        const request = { command: 'echo {{token}}', variables: { token: 'abc-secret' }, serverIds: [1] };
        useMultiExecStore.setState({ requests: { 'done-1': request, 'live-1': request } });
        await useMultiExecStore.getState().refreshList();
        expect(Object.keys(useMultiExecStore.getState().requests).sort()).toEqual(['done-1', 'live-1']);

        vi.advanceTimersByTime(REQUEST_KEEP_MS);
        expect(Object.keys(useMultiExecStore.getState().requests)).toEqual(['live-1']);

        // The backend refused this window's token: nothing is kept.
        notifyUnauthorized(undefined);
        expect(useMultiExecStore.getState()).toMatchObject({ requests: {}, jobs: {}, list: null });
    });
});

describe('composer', () => {
    const servers: ServerSummary[] = [
        { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux' },
        { id: 2, name: 'web-2', ip: '10.0.0.2', type: 'linux' },
    ];
    const name = (id: number) => `#${id}`;

    it('sends a template with its values and shows the secret ones masked', () => {
        const state = {
            ...emptyComposer([1, 2]),
            command: 'mysql -u {{user:root}} -p{{password}} -e "{{query}}" --pin {{pin:3}}',
            values: { password: 'S3cr3t!', query: 'select 1', pin: '7' },
            marks: { marked: ['query'], unmarked: ['pin'] },
        };
        const derived = deriveComposer(state, [], servers, name, t);
        expect(derived.problems).toEqual([]);
        expect(derived.command).toBe('mysql -u root -pS3cr3t! -e "select 1" --pin 7');
        expect(derived.display).toBe('mysql -u root -p{{password}} -e "{{query}}" --pin 7');
        expect(derived.hidesValues).toBe(true);
        expect(derived.request).toEqual({
            command: 'mysql -u {{user:root}} -p{{password}} -e "{{query}}" --pin {{pin:3}}',
            variables: { password: 'S3cr3t!', query: 'select 1', pin: '7' },
            secretVariables: ['query'],
            publicVariables: ['pin'],
            serverIds: [1, 2],
            timeoutSec: 60,
            strategy: DEFAULT_STRATEGY,
            snippet: null,
        });
    });

    it('runs a canary job again on its failed servers without a canary that would take them all', () => {
        const strategy = { ...DEFAULT_STRATEGY, batch: { size: 4, unit: 'servers' as const }, canary: { count: 1, onSuccess: 'pause' as const } };
        const job = info({ strategy, batches: 3, status: 'done' });
        const one = composerFromJob(job, [2], undefined, true);
        expect(one.strategy).toMatchObject({ mode: 'rolling', canary: false, batchSize: '1' });
        expect(deriveComposer(one, [], servers, name, t).problems).toEqual([]);
        expect(deriveComposer(one, [], servers, name, t).request?.strategy).toMatchObject({ canary: null, batch: { size: 1, unit: 'servers' } });
        // With room for it, the canary stays; a new job from this one keeps the rollout as it was.
        expect(composerFromJob(job, [1, 2], undefined, true).strategy).toMatchObject({ canary: true, canaryCount: '1', batchSize: '2' });
        expect(composerFromJob(job, [1], undefined, false).strategy).toMatchObject({ canary: true, batchSize: '4' });
    });

    it('starts from a snippet handed over by the library, or from a job', () => {
        expect(composerFromDraft({ command: 'ls {{dir}}', snippet: { id: 4, name: 'List' }, values: { dir: '/tmp' } }, [2])).toMatchObject({ source: 'snippet', snippetId: '4', values: { dir: '/tmp' }, selected: new Set([2]) });
        expect(composerFromDraft({ command: 'df -h', snippet: { id: 5, name: 'Disk' }, serverIds: [1] }, [2])).toMatchObject({ source: 'command', command: 'df -h', selected: new Set([1]) });

        const history = info({ command: 'echo {{token}}', masked: true, template: 'echo {{token}}', secretVariables: ['token'], timeoutSec: 30 });
        const again = composerFromJob(history, [2], undefined, true);
        expect(again).toMatchObject({ command: 'echo {{token}}', values: {}, rerunOf: 'job-1', timeout: '30', maskedHistory: false });
        expect(deriveComposer(again, [], servers, name, t).missing).toEqual(['token']);
        const redacted = composerFromJob(info({ command: 'curl -H "Authorization: Bearer [REDACTED]"', masked: true }), [1], undefined, true);
        expect(redacted.maskedHistory).toBe(true);
        // A template with typed secret-looking text masked must be checked too.
        const maskedTemplate = info({ command: 'mysql --password=[REDACTED] -e {{q}}', masked: true, template: 'mysql --password=[REDACTED] -e {{q:1}}', templateMasked: true });
        expect(composerFromJob(maskedTemplate, [1], undefined, true)).toMatchObject({ command: 'mysql --password=[REDACTED] -e {{q:1}}', maskedHistory: true });
        // What the user unmarked is read back from the history.
        const unmarked = composerFromJob(info({ template: 'deploy {{pin:v1}} {{token}}', secretVariables: ['token'], variables: { pin: 'v2' } }), [1], undefined, true);
        expect(unmarked.marks).toEqual({ marked: ['token'], unmarked: ['pin'] });
        const inMemory = composerFromJob(history, [2], { command: 'echo {{token}}', variables: { token: 'abc' }, serverIds: [1, 2] }, true);
        expect(deriveComposer(inMemory, [], servers, name, t).problems).toEqual([]);
    });
});
