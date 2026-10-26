import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_STRATEGY, emptyCounts, type MultiExecJobEvent, type MultiExecJobInfo, type MultiExecResult, type MultiExecServerRun } from '@shared/multiexec';
import type { ServerSummary, Snippet } from '@shared/types';
import { ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useSnippetHandoff } from '@/features/snippets/public';
// W8-T3: registers the patch center's kind of job (as the app does at start).
import { clearPatchHandoff, pendingRunHandoff } from '@/features/patch/public';
import { useAppStore } from '@/store/appStore';
import { resetServersStore } from '@/store/servers';
import MultiExecModal from './MultiExecModal';
import { JobNotifier } from './JobNotifier';
import { stopFollowing, useMultiExecStore } from './store';

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux', username: 'deploy', group_name: 'web', tags: ['prod'] },
    { id: 2, name: 'web-2', ip: '10.0.0.2', type: 'linux', group_name: 'web', tags: ['staging'] },
    { id: 3, name: 'win-1', ip: '10.0.0.3', type: 'windows', tags: ['prod'] },
    { id: 4, name: 'bucket', ip: '', type: 's3' },
    { id: 5, name: 'files', ip: '10.0.0.5', type: 'ftp' },
    { id: 6, name: 'console', ip: '', type: 'local' },
];

const SNIPPETS: Snippet[] = [
    { id: 7, name: 'Service status', command: 'systemctl status {{unit:nginx}} --no-pager', description: null, tags: [], server_id: null, created_at: 1, updated_at: 1 },
    { id: 9, name: 'DB check', command: 'mysql -u root -p{{password}} -e "{{query}}"', description: null, tags: [], server_id: null, created_at: 1, updated_at: 1 },
];

type Stream = { push: (event: MultiExecJobEvent) => void; close: () => void };

let calls: Array<{ method: string; path: string; query?: string; body?: unknown }>;
let streams: Map<string, Stream>;
let jobCount: number;
let history: MultiExecJobInfo[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function jobInfo(overrides: Partial<MultiExecJobInfo> = {}): MultiExecJobInfo {
    return {
        id: 'job-1', command: 'uptime', masked: false, template: null, templateMasked: false, variables: null, secretVariables: [], snippet: null, timeoutSec: 60,
        strategy: DEFAULT_STRATEGY, status: 'running', pause: null, stopReason: null, batch: null, batches: 1, nextBatchAt: null, danger: null,
        rerunOf: null, createdAt: Date.now(), finishedAt: null, total: 1, counts: emptyCounts(), ...overrides,
    };
}

function sseResponse(id: string): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    streams.set(id, {
        push: (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
        close: () => controller.close(),
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

// The job the backend creates for a POST body.
function created(body: Record<string, unknown>): MultiExecJobInfo {
    jobCount += 1;
    const strategy = { ...DEFAULT_STRATEGY, ...(body.strategy as object) };
    return jobInfo({
        id: `job-${jobCount}`,
        command: String(body.command),
        total: (body.serverIds as number[]).length,
        strategy,
        timeoutSec: Number(body.timeoutSec ?? 60),
        rerunOf: (body.rerunOf as string | undefined) ?? null,
        batches: strategy.canary ? 2 : 1,
    });
}

function backend(input: RequestInfo | URL, init: RequestInit = {}): Response {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    let match: RegExpExecArray | null;
    if (url.pathname === '/api/servers') return json({ data: SERVERS });
    if (url.pathname === '/api/snippets') return json({ data: SNIPPETS });
    if (url.pathname === '/api/multiexec' && method === 'POST') return json({ message: 'started', data: { job: created(body) } }, 201);
    if (url.pathname === '/api/multiexec/jobs' && method === 'GET') {
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return json({ data: history.filter((info) => before === null || info.createdAt < Number(before)).slice(0, limit) });
    }
    if ((match = /^\/api\/multiexec\/jobs\/([^/]+)\/events$/.exec(url.pathname))) return sseResponse(match[1]);
    if ((match = /^\/api\/multiexec\/jobs\/([^/]+)\/(cancel|pause|resume)$/.exec(url.pathname))) {
        return json({ data: jobInfo({ id: match[1], status: match[2] === 'pause' ? 'paused' : 'running' }) });
    }
    return json({ error: 'unexpected' }, 500);
}

const targetOf = (server: ServerSummary) => ({ serverId: server.id, name: server.name, host: server.ip, type: server.type });

const server = (target: ServerSummary, batch = 0, overrides: Partial<MultiExecServerRun> = {}): MultiExecServerRun => ({
    ...targetOf(target), batch, status: 'queued', exitCode: null, signal: null, error: null, errorCode: null, startedAt: null, finishedAt: null,
    durationMs: null, truncated: false, outputHash: null, normalizedHash: null, stdout: '', stderr: '', outputTrimmed: false, ...overrides,
});

const result = (serverId: number, overrides: Partial<MultiExecResult> = {}): MultiExecResult => ({
    serverId, status: 'ok', exitCode: 0, signal: null, error: null, errorCode: null, startedAt: 1, finishedAt: 2, durationMs: 1200, truncated: false,
    outputHash: 'same', normalizedHash: 'same', ...overrides,
});

async function emit(id: string, event: MultiExecJobEvent) {
    await waitFor(() => expect(streams.has(id)).toBe(true));
    await act(async () => {
        streams.get(id)!.push(event);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const postBodies = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/multiexec').map((call) => call.body as Record<string, unknown>);

async function composeAndRun(serverNames: string[], command: string) {
    for (const name of serverNames) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: command } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: `Run on ${serverNames.length} ${serverNames.length === 1 ? 'server' : 'servers'}` }));
    await waitFor(() => expect(postBodies()).toHaveLength(1));
}

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
    localStorage.clear();
    useAppStore.setState(useAppStore.getInitialState(), true);
    stopFollowing();
    useMultiExecStore.setState(useMultiExecStore.getInitialState(), true);
    useSnippetHandoff.setState(useSnippetHandoff.getInitialState(), true);
    calls = [];
    streams = new Map();
    jobCount = 0;
    history = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => backend(input, init)));
});

afterEach(() => {
    stopFollowing();
    for (const stream of streams.values()) {
        try {
            stream.close();
        } catch {
            // Already closed.
        }
    }
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('multi-exec composer', () => {
    it('only offers SSH servers and filters them by search, group and tag', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        const list = await screen.findByRole('list', { name: 'Servers' });
        const shown = () => within(list).queryAllByRole('checkbox').map((box) => box.closest('label')?.querySelector('span')?.textContent);
        expect(shown()).toEqual(['web-1', 'web-2', 'win-1']);

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search servers' }), { target: { value: 'WIN' } });
        expect(shown()).toEqual(['win-1']);
        fireEvent.click(screen.getByRole('button', { name: 'Select shown (1)' }));
        expect(screen.getByText('Selected: 1')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search servers' }), { target: { value: '' } });

        fireEvent.click(within(screen.getByRole('group', { name: 'Tag' })).getByRole('combobox', { name: 'All tags' }));
        fireEvent.click(screen.getByRole('option', { name: 'prod' }));
        expect(shown()).toEqual(['web-1', 'win-1']);
        fireEvent.click(within(screen.getByRole('group', { name: 'Group' })).getByRole('combobox', { name: 'All groups' }));
        fireEvent.click(screen.getByRole('option', { name: 'web' }));
        expect(shown()).toEqual(['web-1']);
        fireEvent.click(screen.getByRole('button', { name: 'Select shown (1)' }));
        expect(screen.getByText('Selected: 2')).toBeInTheDocument();
    });

    it('preselects the active SSH server', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={SERVERS[1]} />);
        expect(await screen.findByRole('checkbox', { name: /^web-2/ })).toBeChecked();
        expect(screen.getByText('Selected: 1')).toBeInTheDocument();
    });

    it('explains what is missing before the review', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('list', { name: 'Servers' });
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Timeout per server (seconds)' }), { target: { value: '0' } });
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Select at least one server.');
        expect(alert).toHaveTextContent('Enter a command.');
        expect(alert).toHaveTextContent('The timeout must be a whole number of seconds from 1 to 3600.');
        expect(screen.queryByRole('button', { name: /^Run on/ })).toBeNull();
    });

    it('rolls out in batches with a canary and a failure limit', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        for (const name of ['web-1', 'web-2', 'win-1']) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'apt-get -y upgrade' } });
        fireEvent.click(screen.getByRole('radio', { name: 'Rolling batches' }));
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Batch size' }), { target: { value: '50' } });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Start with a canary' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Stop after failures' }));
        expect(screen.getByRole('list', { name: 'Plan' })).toHaveTextContent('Canary: 1 server first, then wait for your approval.');
        expect(screen.getByRole('list', { name: 'Plan' })).toHaveTextContent('Then the remaining 2 servers, up to 5 at a time.');
        expect(screen.getByRole('list', { name: 'Plan' })).toHaveTextContent('Stops at the first failure.');

        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 3 servers' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toEqual({
            command: 'apt-get -y upgrade',
            serverIds: [1, 2, 3],
            timeoutSec: 60,
            strategy: { concurrency: 5, batch: { size: 50, unit: 'percent' }, pauseSec: 0, canary: { count: 1, onSuccess: 'pause' }, failureLimit: { count: 1, percent: null } },
            snippet: null,
        });
    });
});

describe('multi-exec jobs', () => {
    it('runs a job, groups identical outputs, compares the different ones and reruns the failed', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        for (const name of ['web-1', 'web-2', 'win-1']) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'cat /etc/motd' } });
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Timeout per server (seconds)' }), { target: { value: '30' } });
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Parallel servers' }), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));

        expect(screen.getByRole('heading', { name: 'Run this command on 3 servers?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Run on 3 servers' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({ command: 'cat /etc/motd', serverIds: [1, 2, 3], timeoutSec: 30, strategy: expect.objectContaining({ concurrency: 2 }) });

        await emit('job-1', { type: 'running', serverId: 1, startedAt: Date.now() });
        expect(await screen.findByText('Running… 0 of 3 finished')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument();
        await emit('job-1', { type: 'output', serverId: 1, stream: 'stdout', data: 'Welcome\nversion 2\n' });
        await emit('job-1', { type: 'result', result: result(1, { outputHash: 'a', normalizedHash: 'a' }) });
        await emit('job-1', { type: 'output', serverId: 2, stream: 'stdout', data: 'Welcome\nversion 2\n' });
        await emit('job-1', { type: 'result', result: result(2, { outputHash: 'a', normalizedHash: 'a' }) });
        await emit('job-1', { type: 'output', serverId: 3, stream: 'stdout', data: 'Welcome\nversion 1\n' });
        await emit('job-1', { type: 'result', result: result(3, { status: 'failed', exitCode: 1, outputHash: 'b', normalizedHash: 'b' }) });
        await emit('job-1', { type: 'job', job: jobInfo({ id: 'job-1', command: 'cat /etc/motd', status: 'done', finishedAt: Date.now(), total: 3, timeoutSec: 30 }) });

        expect(screen.getByText('Finished: 2 OK, 1 failed')).toBeInTheDocument();
        const groups = within(screen.getByRole('list', { name: 'Results by output' })).getAllByRole('listitem').filter((item) => item.parentElement?.getAttribute('aria-label') === 'Results by output');
        expect(screen.getByText('2 identical, 1 different')).toBeInTheDocument();
        expect(groups[0]).toHaveTextContent('Group A · most common output');
        expect(groups[0]).toHaveTextContent('2 servers');
        expect(groups[1]).toHaveTextContent('Group B · different output');

        fireEvent.click(within(groups[1]).getByRole('button', { name: 'Compare with A' }));
        const diff = within(groups[1]).getByRole('table', { name: 'Differences between Group A and Group B' });
        expect(diff).toHaveTextContent('version 2');
        expect(diff).toHaveTextContent('version 1');
        expect(within(groups[1]).getByText('1 line added, 1 removed')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('radio', { name: 'By server' }));
        const rows = within(screen.getByRole('list', { name: 'Results by server' })).getAllByRole('listitem');
        expect(rows[0]).toHaveTextContent(/web-1.*OK.*exit 0/);
        expect(rows[2]).toHaveTextContent(/win-1.*Failed.*exit 1/);
        fireEvent.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: 'Failed · 1' }));
        expect(within(screen.getByRole('list', { name: 'Results by server' })).getAllByRole('listitem')).toHaveLength(1);

        // The rerun goes back to the review, on the failed server only.
        fireEvent.click(screen.getByRole('button', { name: 'Run again where it failed (1)' }));
        expect(screen.getByRole('heading', { name: 'Run this command on 1 server?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(2));
        expect(postBodies()[1]).toMatchObject({ command: 'cat /etc/motd', serverIds: [3], timeoutSec: 30, rerunOf: 'job-1' });

        // What is composed next is a job of its own.
        fireEvent.click(screen.getByRole('tab', { name: 'New job' }));
        expect(screen.queryByText('Running the job again on the servers where it did not succeed.')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(3));
        expect(postBodies()[2]).not.toHaveProperty('rerunOf');
    });

    it('explains failures in the user language', async () => {
        setLanguage('es');
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        for (const name of ['web-1', 'web-2']) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Comando' }), { target: { value: 'sleep 20' } });
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Tiempo límite por servidor (segundos)' }), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));
        fireEvent.click(screen.getByRole('button', { name: 'Ejecutar en 2 servidores' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));

        await emit('job-1', { type: 'result', result: result(1, { status: 'timeout', exitCode: null, error: 'The command did not finish within 2s', errorCode: 'TIMEOUT', outputHash: null, normalizedHash: null }) });
        await emit('job-1', { type: 'result', result: result(2, { status: 'failed', exitCode: null, error: 'connect ECONNREFUSED 10.0.0.2:22', errorCode: 'CONNECTION_REFUSED', outputHash: null, normalizedHash: null }) });
        await emit('job-1', { type: 'job', job: jobInfo({ id: 'job-1', command: 'sleep 20', status: 'done', finishedAt: Date.now(), total: 2, timeoutSec: 2 }) });

        fireEvent.click(screen.getByRole('radio', { name: 'Por servidor' }));
        fireEvent.click(screen.getByRole('button', { name: 'Desplegar todo' }));
        const rows = within(screen.getByRole('list', { name: 'Resultados por servidor' })).getAllByRole('listitem');
        expect(rows[0]).toHaveTextContent('El comando no terminó en 2 s y se detuvo.');
        expect(rows[1]).toHaveTextContent('El servidor rechazó la conexión. ¿Está SSH escuchando en ese puerto?');
        expect(rows[1]).toHaveTextContent('connect ECONNREFUSED 10.0.0.2:22');
        expect(screen.getByRole('button', { name: 'Repetir donde falló (2)' })).toBeInTheDocument();
    });

    it('waits for approval after the canary and continues it', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        for (const name of ['web-1', 'web-2']) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'deploy' } });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Start with a canary' }));
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 2 servers' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));

        const job = jobInfo({ id: 'job-1', command: 'deploy', total: 2, batches: 2, strategy: { ...DEFAULT_STRATEGY, canary: { count: 1, onSuccess: 'pause' } } });
        await emit('job-1', { type: 'snapshot', job: { ...job, servers: [server(SERVERS[0], 0), server(SERVERS[1], 1)] } });
        await emit('job-1', { type: 'result', result: result(1) });
        await emit('job-1', { type: 'job', job: { ...job, status: 'paused', batch: 0, pause: { reason: 'canary', since: Date.now(), expiresAt: Date.now() + 30 * 60_000 } } });
        const gate = screen.getByRole('group', { name: 'Canary finished: 1 of 1 OK. Continue with the remaining server?' });
        expect(within(gate).getByRole('alert')).toHaveTextContent('Canary finished');
        expect(screen.getByRole('list', { name: 'Batches' })).toBeInTheDocument();

        fireEvent.click(within(gate).getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/multiexec/jobs/job-1/resume')).toBe(true));
    });

    it('keeps a job going while the dialog is closed, and cancels it', async () => {
        const { unmount } = render(<MultiExecModal onClose={vi.fn()} server={null} />);
        await composeAndRun(['web-1', 'web-2'], 'sleep 100');
        await emit('job-1', { type: 'running', serverId: 1, startedAt: Date.now() });

        unmount();
        await emit('job-1', { type: 'running', serverId: 2, startedAt: Date.now() });
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        expect(await screen.findByText('Running… 0 of 2 finished')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /Jobs.*1 running/ })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/multiexec/jobs/job-1/cancel')).toBe(true));
        for (const serverId of [1, 2]) await emit('job-1', { type: 'result', result: result(serverId, { status: 'cancelled', exitCode: null, outputHash: null, normalizedHash: null }) });
        await emit('job-1', { type: 'job', job: jobInfo({ id: 'job-1', command: 'sleep 100', status: 'cancelled', finishedAt: Date.now(), total: 2 }) });
        expect(screen.getByText('Job cancelled')).toBeInTheDocument();
        // CR-01: both were cancelled while the command ran there: it may
        // have run, so "Run again" leaves them out and says why.
        expect(screen.queryByRole('button', { name: /^Run again/ })).toBeNull();
        expect(screen.getByRole('note')).toHaveTextContent('Not part of "Run again": 2 servers where the job was cut off while the command ran. It may have run there already; start a new job to include them.');
        expect(screen.getByRole('button', { name: 'New job from this one' })).toBeInTheDocument();
    });

    it('runs again where a cancelled job never started the command', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        await composeAndRun(['web-1', 'web-2'], 'sleep 100');
        await emit('job-1', { type: 'running', serverId: 1, startedAt: Date.now() });
        await emit('job-1', { type: 'result', result: result(1, { status: 'cancelled', exitCode: null, outputHash: null, normalizedHash: null }) });
        await emit('job-1', { type: 'result', result: result(2, { status: 'cancelled', exitCode: null, startedAt: null, finishedAt: null, durationMs: null, outputHash: null, normalizedHash: null }) });
        await emit('job-1', { type: 'job', job: jobInfo({ id: 'job-1', command: 'sleep 100', status: 'cancelled', finishedAt: Date.now(), total: 2 }) });
        expect(await screen.findByRole('button', { name: 'Run again where it did not succeed (1)' })).toBeInTheDocument();
        expect(screen.getByRole('note')).toHaveTextContent('Not part of "Run again": 1 server where the job was cut off');
    });

    it('lists running and finished jobs and opens one from the history', async () => {
        history = [
            jobInfo({ id: 'job-old', command: 'df -h', status: 'done', finishedAt: Date.now() - 1000, total: 2, counts: { ...emptyCounts(), ok: 1, failed: 1 } }),
        ];
        render(<MultiExecModal onClose={vi.fn()} server={null} initialView="jobs" />);
        const finished = await screen.findByRole('region', { name: 'History' });
        expect(finished).toHaveTextContent('df -h');
        expect(finished).toHaveTextContent('1 OK · 1 failed');
        fireEvent.click(within(finished).getByRole('button', { name: /df -h/ }));
        await emit('job-old', {
            type: 'snapshot',
            job: { ...history[0], servers: [server(SERVERS[0], 0, { status: 'ok', exitCode: 0, stdout: '/dev/sda1 40%\n', outputHash: 'x', normalizedHash: 'x' }), server(SERVERS[1], 0, { status: 'failed', exitCode: 1, outputHash: 'y', normalizedHash: 'y' })] },
        });
        await emit('job-old', { type: 'end' });
        expect(await screen.findByText('Finished: 1 OK, 1 failed')).toBeInTheDocument();
        expect(screen.getByText('1 identical, 1 different')).toBeInTheDocument();
    });

    it('reports a job the backend refuses on the review', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/multiexec') return json({ error: 'At most 4 multi-exec jobs can run at once.', code: 'MULTIEXEC_BUSY' }, 429);
            return backend(input, init);
        }));
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /^web-1/ }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'uptime' } });
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Too many multi-exec jobs are running right now. Wait for one to finish and try again.');
        expect(screen.getByRole('button', { name: 'Run on 1 server' })).toBeInTheDocument();
    });

    it('tells the user when a job ends while the dialog is closed', async () => {
        render(<ToastProvider><JobNotifier /><MultiExecModal onClose={vi.fn()} server={null} /></ToastProvider>);
        await composeAndRun(['web-1'], 'uptime');
        await emit('job-1', { type: 'running', serverId: 1, startedAt: Date.now() });
        // The job on screen gets no notification; once it is not shown, it does.
        act(() => useMultiExecStore.getState().setVisibleJob(null));
        await emit('job-1', { type: 'result', result: result(1) });
        await emit('job-1', { type: 'job', job: jobInfo({ id: 'job-1', status: 'done', finishedAt: Date.now() }) });
        expect(await screen.findByText('Multi-exec job finished: 1 OK')).toBeInTheDocument();
    });
});

describe('snippets and secrets in multi-exec', () => {
    it('lists snippets scoped to a selected server and keeps them on that server', async () => {
        const scoped: Snippet = { id: 8, name: 'Reload nginx', command: 'nginx -s reload', description: null, tags: [], server_id: 1, created_at: 1, updated_at: 1 };
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (new URL(String(input)).pathname === '/api/snippets') return json({ data: [...SNIPPETS, scoped] });
            return backend(input, init);
        }));
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /^web-2/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Snippet' }));
        const picker = () => within(screen.getByRole('group', { name: 'Snippet' })).getByRole('combobox');
        fireEvent.click(picker());
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Service status'), expect.stringContaining('DB check')]);
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

        fireEvent.click(screen.getByRole('checkbox', { name: /^web-1/ }));
        fireEvent.click(picker());
        expect(screen.getByRole('option', { name: /Reload nginx/ })).toHaveTextContent('Only web-1 · nginx -s reload');
        fireEvent.click(screen.getByRole('option', { name: /Reload nginx/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByRole('alert')).toHaveTextContent('"Reload nginx" is only available on web-1: select only that server, or choose another snippet.');

        fireEvent.click(screen.getByRole('checkbox', { name: /^web-2/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({ command: 'nginx -s reload', serverIds: [1], snippet: { id: 8, name: 'Reload nginx' } });
    });

    it('sends a snippet as its template and values, with the secret ones masked on screen', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /^web-1/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Snippet' }));
        fireEvent.click(within(screen.getByRole('group', { name: 'Snippet' })).getByRole('combobox'));
        fireEvent.click(screen.getByRole('option', { name: /DB check/ }));

        const password = screen.getByLabelText(/^password/);
        expect(password).toHaveAttribute('type', 'password');
        fireEvent.change(password, { target: { value: 'S3cr3t-value' } });
        fireEvent.change(screen.getByLabelText(/^query/), { target: { value: 'select 1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Treat query as a secret' }));
        expect(screen.getByLabelText(/^query/)).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('mysql -u root -p{{password}} -e "{{query}}"');
        expect(document.body).not.toHaveTextContent('S3cr3t-value');

        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(screen.getByLabelText('Command')).toHaveTextContent('mysql -u root -p{{password}} -e "{{query}}"');
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({
            command: 'mysql -u root -p{{password}} -e "{{query}}"',
            variables: { password: 'S3cr3t-value', query: 'select 1' },
            secretVariables: ['query'],
            snippet: { id: 9, name: 'DB check' },
        });
        // Secret values are never remembered on the device.
        expect(localStorage.getItem('shellmind.snippets.values.9')).toBeNull();
    });

    it('starts from a snippet handed over by the library (also under StrictMode)', async () => {
        useSnippetHandoff.getState().prepare({ command: 'systemctl status {{unit:nginx}} --no-pager', snippet: { id: 7, name: 'Service status' }, values: { unit: 'sshd' } });
        // The app renders in StrictMode, which runs state initializers twice.
        render(<StrictMode><MultiExecModal onClose={vi.fn()} server={null} /></StrictMode>);
        expect(await screen.findByLabelText('unit')).toHaveValue('sshd');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('systemctl status sshd --no-pager');
        expect(useSnippetHandoff.getState().draft).toBeNull();

        fireEvent.click(await screen.findByRole('checkbox', { name: /^web-1/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({ command: 'systemctl status {{unit:nginx}} --no-pager', variables: { unit: 'sshd' }, snippet: { id: 7, name: 'Service status' } });
        expect(JSON.parse(localStorage.getItem('shellmind.snippets.values.7')!)).toEqual({ unit: 'sshd' });
    });

    it('asks for the number of servers before a destructive command', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        await composeAndRunUntilReview(['web-1', 'web-2'], 'rm -rf /etc');
        expect(screen.getByRole('group', { name: 'Destructive command' })).toHaveTextContent('This command deletes files recursively, and it will run on 2 servers.');
        const run = screen.getByRole('button', { name: 'Run on 2 servers' });
        expect(run).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Type 2 (the number of servers) to confirm:'), { target: { value: '3' } });
        expect(run).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Type 2 (the number of servers) to confirm:'), { target: { value: '2' } });
        expect(run).toBeEnabled();
        fireEvent.click(run);
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({ command: 'rm -rf /etc', confirmDangerous: true });
    });
});

describe('reruns, focus and the history', () => {
    const canary = { ...DEFAULT_STRATEGY, canary: { count: 1, onSuccess: 'pause' as const } };

    it('runs a canary job again where it failed, straight from the history, without a canary', async () => {
        history = [jobInfo({ id: 'job-old', command: 'deploy', status: 'done', finishedAt: Date.now(), total: 2, batches: 2, strategy: canary })];
        render(<MultiExecModal onClose={vi.fn()} server={null} initialView="jobs" />);
        fireEvent.click(within(await screen.findByRole('region', { name: 'History' })).getByRole('button', { name: /deploy/ }));
        await emit('job-old', {
            type: 'snapshot',
            job: {
                ...history[0],
                servers: [
                    server(SERVERS[0], 0, { status: 'ok', exitCode: 0, stdout: 'deployed\n', outputHash: 'a', normalizedHash: 'a' }),
                    server(SERVERS[1], 1, { status: 'failed', exitCode: 1, stderr: 'disk full\n', outputHash: 'b', normalizedHash: 'b' }),
                ],
            },
        });
        await emit('job-old', { type: 'end' });

        const rerun = await screen.findByRole('button', { name: 'Run again where it failed (1)' });
        rerun.focus();
        fireEvent.click(rerun);
        // Straight to the review: a canary of 1 cannot run before 1 server.
        const heading = screen.getByRole('heading', { name: 'Run this command on 1 server?' });
        expect(screen.getByText('Runs on 1 server.')).toBeInTheDocument();
        expect(document.activeElement).toBe(heading);
        fireEvent.click(screen.getByRole('button', { name: 'Run on 1 server' }));
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        expect(postBodies()[0]).toMatchObject({ command: 'deploy', serverIds: [2], rerunOf: 'job-old', strategy: expect.objectContaining({ canary: null }) });
    });

    it('moves the focus into each view it shows', async () => {
        render(<MultiExecModal onClose={vi.fn()} server={null} />);
        for (const name of ['web-1', 'web-2']) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
        // A review with problems goes to the first field that has one.
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Timeout per server (seconds)' }), { target: { value: '0' } });
        const review = screen.getByRole('button', { name: 'Review' });
        review.focus();
        fireEvent.click(review);
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Command' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'rm -rf /etc' } });
        review.focus();
        fireEvent.click(review);
        expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: 'Timeout per server (seconds)' }));
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Timeout per server (seconds)' }), { target: { value: '60' } });
        screen.getByRole('button', { name: 'Review' }).focus();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        // The typed confirmation of a destructive command.
        const typed = screen.getByLabelText('Type 2 (the number of servers) to confirm:');
        expect(document.activeElement).toBe(typed);

        fireEvent.change(typed, { target: { value: '2' } });
        const back = screen.getByRole('button', { name: 'Back' });
        back.focus();
        fireEvent.click(back);
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Command' }));

        screen.getByRole('button', { name: 'Review' }).focus();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        fireEvent.change(screen.getByLabelText('Type 2 (the number of servers) to confirm:'), { target: { value: '2' } });
        const run = screen.getByRole('button', { name: 'Run on 2 servers' });
        run.focus();
        fireEvent.click(run);
        await waitFor(() => expect(postBodies()).toHaveLength(1));
        await waitFor(() => expect(document.activeElement).toHaveTextContent('Running… 0 of 2 finished'));
        expect(document.activeElement).toHaveAttribute('role', 'status');

        const all = screen.getByRole('button', { name: 'All jobs' });
        all.focus();
        fireEvent.click(all);
        await waitFor(() => expect(document.activeElement).toHaveTextContent('Running · 1'));
        expect(document.activeElement?.tagName).toBe('H3');

        // A tab picked by the user keeps the focus.
        const tab = screen.getByRole('tab', { name: 'New job' });
        tab.focus();
        fireEvent.click(tab);
        expect(document.activeElement).toBe(tab);
    });

    it('loads the older jobs of the history a page at a time', async () => {
        const now = Date.now();
        history = Array.from({ length: 60 }, (_, index) => jobInfo({ id: `old-${index}`, command: `echo ${index}`, status: 'done', createdAt: now - index * 1000, finishedAt: now - index * 1000 + 10 }));
        render(<MultiExecModal onClose={vi.fn()} server={null} initialView="jobs" />);
        const region = await screen.findByRole('region', { name: 'History' });
        expect(within(region).getAllByRole('listitem')).toHaveLength(50);

        fireEvent.click(screen.getByRole('button', { name: 'Show older jobs' }));
        await waitFor(() => expect(within(screen.getByRole('region', { name: 'History' })).getAllByRole('listitem')).toHaveLength(60));
        expect(calls.some((call) => call.method === 'GET' && call.path === '/api/multiexec/jobs' && call.query?.includes(`before=${now - 49_000}`))).toBe(true);
        expect(screen.queryByRole('button', { name: 'Show older jobs' })).toBeNull();
        expect(screen.getByRole('heading', { name: 'History · 60' })).toBeInTheDocument();
    });
});

// --- W8-T3 patch center ---
describe('patch center jobs in the history', () => {
    it('runs a patch job again from the patch center only, and words what ShellMind said in it', async () => {
        const command = '# ShellMind patch center: install security updates, then reboot where a reboot is required\nLC_ALL=C\nexport LC_ALL\nmode=security\nrefresh=0\n';
        history = [jobInfo({ id: 'job-patch', command, status: 'done', finishedAt: Date.now(), total: 2, danger: 'power' })];
        setLanguage('es');
        render(<MultiExecModal onClose={vi.fn()} server={null} initialView="jobs" />);
        fireEvent.click(within(await screen.findByRole('region', { name: 'Historial' })).getByRole('button', { name: /ShellMind patch center/ }));
        await emit('job-patch', {
            type: 'snapshot',
            job: {
                ...history[0],
                servers: [
                    server(SERVERS[0], 0, { status: 'ok', exitCode: 0, stdout: '[shellmind] manager=apt\n[shellmind] reboot-required=yes\n[shellmind] reboot=start\n[shellmind] reboot=back after=42 up=9 state=running failed=0\n' }),
                    server(SERVERS[1], 0, { status: 'failed', exitCode: null, error: '[shellmind] reboot-failed=timeout wait=600 | connect ECONNREFUSED 10.0.0.2:22' }),
                ],
            },
        });
        await emit('job-patch', { type: 'end' });

        // No plain multi-exec rerun: it would skip the patch center's plan, reboot and audit.
        expect(await screen.findByRole('button', { name: 'Abrir en el centro de parches' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Repetir donde|Nuevo trabajo a partir de este/ })).toBeNull();
        fireEvent.click(screen.getByRole('radio', { name: 'Por servidor' }));
        fireEvent.click(screen.getByRole('button', { name: 'Desplegar todo' }));
        const rows = within(screen.getByRole('list', { name: 'Resultados por servidor' })).getAllByRole('listitem');
        expect(rows[0]).toHaveTextContent('[shellmind] Gestor de paquetes: apt.');
        expect(rows[0]).toHaveTextContent('[shellmind] Hace falta reiniciar.');
        expect(rows[0]).toHaveTextContent('[shellmind] De vuelta tras 42 s · encendido desde hace 9 s · sistema running · 0 unidades fallidas');
        expect(rows[1]).toHaveTextContent('El servidor no ha respondido por SSH en los 10 min siguientes al reinicio. Último intento: connect ECONNREFUSED 10.0.0.2:22');

        // Patching again where it failed plans a new run in the patch center.
        fireEvent.click(screen.getByRole('button', { name: 'Volver a parchear donde falló (1)' }));
        expect(useAppStore.getState().activeActionId).toBe('patch-center');
        expect(pendingRunHandoff()).toEqual({ serverIds: [2], mode: 'security' });
        clearPatchHandoff();
        setLanguage('en');
    });
});
// --- end W8-T3 ---

async function composeAndRunUntilReview(serverNames: string[], command: string) {
    for (const name of serverNames) fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${name}`) }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: command } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
}
