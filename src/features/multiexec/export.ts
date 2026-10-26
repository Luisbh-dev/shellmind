import type { MultiExecServerRun } from '@shared/multiexec';
import type { TranslateFn } from '@/i18n';
import { serverErrorText } from './errors';
import type { JobView } from './store';

// Results of a job as a file: JSON (complete, machine-readable), CSV (one row
// per server, for a spreadsheet) or text (one section per server, for
// reading or pasting into a ticket). The command is the recorded form: the
// values of secret variables are never in an export.

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function jobToJson(view: JobView): string {
    const { info } = view;
    return JSON.stringify({
        jobId: info.id,
        command: info.command,
        snippet: info.snippet,
        status: info.status,
        stopReason: info.stopReason,
        timeoutSec: info.timeoutSec,
        strategy: info.strategy,
        rerunOf: info.rerunOf,
        createdAt: iso(info.createdAt),
        finishedAt: iso(info.finishedAt),
        results: view.servers.map((server) => ({
            serverId: server.serverId,
            server: server.name,
            host: server.host,
            type: server.type,
            batch: server.batch + 1,
            status: server.status,
            exitCode: server.exitCode,
            signal: server.signal,
            error: server.error,
            errorCode: server.errorCode,
            startedAt: iso(server.startedAt),
            finishedAt: iso(server.finishedAt),
            durationMs: server.durationMs,
            truncated: server.truncated,
            outputTrimmed: server.outputTrimmed,
            outputHash: server.outputHash,
            stdout: server.stdout,
            stderr: server.stderr
        }))
    }, null, 2);
}

// Text cells a spreadsheet would evaluate as a formula get a leading
// apostrophe (outputs are untrusted text).
const FORMULA_START = /^[=+\-@\t\r]/;
const UTF8_BOM = String.fromCharCode(0xfeff);

function csvCell(value: string | number | boolean | null | undefined, text = false): string {
    if (value === null || value === undefined) return '';
    let cell = String(value);
    if (text && FORMULA_START.test(cell)) cell = `'${cell}`;
    return /[",\r\n]/.test(cell) || /^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export const JOB_CSV_COLUMNS = ['server_id', 'server', 'host', 'type', 'batch', 'status', 'exit_code', 'duration_ms', 'error', 'started_at', 'finished_at', 'stdout', 'stderr'] as const;

export function jobToCsv(view: JobView): string {
    const rows = view.servers.map((server: MultiExecServerRun) => [
        csvCell(server.serverId),
        csvCell(server.name, true),
        csvCell(server.host, true),
        csvCell(server.type),
        csvCell(server.batch + 1),
        csvCell(server.status),
        csvCell(server.exitCode),
        csvCell(server.durationMs),
        csvCell(server.error, true),
        csvCell(iso(server.startedAt)),
        csvCell(iso(server.finishedAt)),
        csvCell(server.stdout, true),
        csvCell(server.stderr, true)
    ].join(','));
    return `${UTF8_BOM}${[JOB_CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

export function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    if (minutes < 60) return `${minutes} min ${seconds} s`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function jobToText(view: JobView, t: TranslateFn): string {
    const { info } = view;
    const lines = [
        `# ${t('multiexec.export.title')}`,
        `${t('multiexec.export.command')}: ${info.command.includes('\n') ? `\n${info.command}` : info.command}`,
        `${t('multiexec.export.started')}: ${iso(info.createdAt)}`,
        `${t('multiexec.export.status')}: ${t(`multiexec.jobStatus.${info.status}`)}`,
        `${t('multiexec.export.servers')}: ${view.servers.length}`,
        ''
    ];
    for (const server of view.servers) {
        const exit = server.exitCode === null ? '' : `, ${t('multiexec.export.exit', { code: server.exitCode })}`;
        lines.push(`=== ${server.name} (${server.host}) — ${t(`multiexec.status.${server.status}`)}${exit}, ${formatDuration(server.durationMs)} ===`);
        const failure = serverErrorText(server, info.timeoutSec, t);
        if (failure) lines.push(`${t('multiexec.export.error')}: ${failure.message}${failure.detail ? ` (${failure.detail})` : ''}`);
        if (server.stdout) lines.push('--- stdout ---', server.stdout.replace(/\n$/, ''));
        if (server.stderr) lines.push('--- stderr ---', server.stderr.replace(/\n$/, ''));
        if (server.truncated) lines.push(`[${t('multiexec.results.truncated')}]`);
        else if (server.outputTrimmed) lines.push(`[${t('multiexec.results.trimmed')}]`);
        lines.push('');
    }
    return lines.join('\n');
}
