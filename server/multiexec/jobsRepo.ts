import { gunzipSync, gzipSync } from "zlib";
import {
    DEFAULT_STRATEGY,
    MULTIEXEC_STATUSES,
    emptyCounts,
    type MultiExecCounts,
    type MultiExecErrorCode,
    type MultiExecJob,
    type MultiExecJobInfo,
    type MultiExecJobStatus,
    type MultiExecServerRun,
    type MultiExecStatus,
    type MultiExecStrategy
} from "../../shared/multiexec";
import type { ServerType } from "../../shared/types";
import { dbAll, dbGet, dbRun, transaction } from "../db/sqlite";
import { createLogger } from "../logger";

// The job history (tables multiexec_jobs and multiexec_job_results, schema
// v14). A job row holds what was asked and how it stands; each server of it
// has a row with its result and the start of its output, gzipped.

const log = createLogger("multiexec");

type JobRow = {
    id: string;
    command: string;
    masked: number;
    template: string | null;
    template_masked: number;
    variables: string | null;
    secret_variables: string | null;
    snippet_id: number | null;
    snippet_name: string | null;
    timeout_sec: number;
    strategy: string;
    status: MultiExecJobStatus;
    pause: string | null;
    stop_reason: MultiExecJobInfo["stopReason"];
    batch: number | null;
    batches: number;
    danger: MultiExecJobInfo["danger"];
    rerun_of: string | null;
    total: number;
    created_at: number;
    finished_at: number | null;
};

type ResultRow = {
    job_id: string;
    position: number;
    server_id: number;
    server_name: string;
    host: string;
    server_type: ServerType;
    batch: number;
    status: MultiExecStatus;
    exit_code: number | null;
    signal: string | null;
    error: string | null;
    error_code: MultiExecErrorCode | null;
    started_at: number | null;
    finished_at: number | null;
    duration_ms: number | null;
    truncated: number;
    output_hash: string | null;
    normalized_hash: string | null;
    output: Buffer | null;
    output_trimmed: number;
};

function parseJson<T>(text: string | null, fallback: T): T {
    if (!text) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
}

function toInfo(row: JobRow, counts: MultiExecCounts): MultiExecJobInfo {
    return {
        id: row.id,
        command: row.command,
        masked: row.masked === 1,
        template: row.template,
        templateMasked: row.template_masked === 1,
        variables: parseJson<Record<string, string> | null>(row.variables, null),
        secretVariables: parseJson<string[]>(row.secret_variables, []),
        snippet: row.snippet_name === null ? null : { id: row.snippet_id, name: row.snippet_name },
        timeoutSec: row.timeout_sec,
        strategy: { ...DEFAULT_STRATEGY, ...parseJson<Partial<MultiExecStrategy>>(row.strategy, {}) },
        status: row.status,
        pause: parseJson<MultiExecJobInfo["pause"]>(row.pause, null),
        stopReason: row.stop_reason,
        batch: row.batch,
        batches: row.batches,
        nextBatchAt: null,
        danger: row.danger,
        rerunOf: row.rerun_of,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        total: row.total,
        counts
    };
}

export function packOutput(stdout: string, stderr: string): Buffer | null {
    if (!stdout && !stderr) return null;
    return gzipSync(Buffer.from(JSON.stringify({ stdout, stderr }), "utf8"));
}

function unpackOutput(blob: Buffer | null): { stdout: string; stderr: string } {
    if (!blob) return { stdout: "", stderr: "" };
    try {
        const parsed = JSON.parse(gunzipSync(blob).toString("utf8")) as { stdout?: unknown; stderr?: unknown };
        return { stdout: typeof parsed.stdout === "string" ? parsed.stdout : "", stderr: typeof parsed.stderr === "string" ? parsed.stderr : "" };
    } catch (err) {
        log.warn("A stored multi-exec output could not be read", err);
        return { stdout: "", stderr: "" };
    }
}

function toServerRun(row: ResultRow): MultiExecServerRun {
    return {
        serverId: row.server_id,
        name: row.server_name,
        host: row.host,
        type: row.server_type,
        batch: row.batch,
        status: row.status,
        exitCode: row.exit_code,
        signal: row.signal,
        error: row.error,
        errorCode: row.error_code,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: row.duration_ms,
        truncated: row.truncated === 1,
        outputHash: row.output_hash,
        normalizedHash: row.normalized_hash,
        outputTrimmed: row.output_trimmed === 1,
        ...unpackOutput(row.output)
    };
}

async function countsFor(ids: string[]): Promise<Map<string, MultiExecCounts>> {
    const counts = new Map<string, MultiExecCounts>(ids.map((id) => [id, emptyCounts()]));
    if (ids.length === 0) return counts;
    const rows = await dbAll<{ job_id: string; status: MultiExecStatus; count: number }>(
        `SELECT job_id, status, COUNT(*) AS count FROM multiexec_job_results WHERE job_id IN (${ids.map(() => "?").join(", ")}) GROUP BY job_id, status`,
        ids
    );
    for (const row of rows) {
        const entry = counts.get(row.job_id);
        if (entry && MULTIEXEC_STATUSES.includes(row.status)) entry[row.status] = row.count;
    }
    return counts;
}

const ACTIVE = "('running', 'paused')";

export const jobsRepo = {
    async insert(job: MultiExecJob): Promise<void> {
        await transaction(async (tx) => {
            await tx.run(
                `INSERT INTO multiexec_jobs (id, command, masked, template, template_masked, variables, secret_variables, snippet_id, snippet_name,
                    timeout_sec, strategy, status, pause, stop_reason, batch, batches, danger, rerun_of, total, created_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    job.id, job.command, job.masked ? 1 : 0, job.template, job.templateMasked ? 1 : 0, job.variables ? JSON.stringify(job.variables) : null,
                    JSON.stringify(job.secretVariables), job.snippet?.id ?? null, job.snippet?.name ?? null, job.timeoutSec,
                    JSON.stringify(job.strategy), job.status, job.pause ? JSON.stringify(job.pause) : null, job.stopReason, job.batch,
                    job.batches, job.danger, job.rerunOf, job.total, job.createdAt, job.finishedAt
                ]
            );
            for (const [position, server] of job.servers.entries()) {
                await tx.run(
                    `INSERT INTO multiexec_job_results (job_id, position, server_id, server_name, host, server_type, batch, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [job.id, position, server.serverId, server.name, server.host, server.type, server.batch, server.status]
                );
            }
        });
    },

    async updateState(info: MultiExecJobInfo): Promise<void> {
        await dbRun(
            "UPDATE multiexec_jobs SET status = ?, pause = ?, stop_reason = ?, batch = ?, finished_at = ? WHERE id = ?",
            [info.status, info.pause ? JSON.stringify(info.pause) : null, info.stopReason, info.batch, info.finishedAt, info.id]
        );
    },

    async updateServer(jobId: string, position: number, server: MultiExecServerRun): Promise<void> {
        await dbRun(
            `UPDATE multiexec_job_results SET status = ?, exit_code = ?, signal = ?, error = ?, error_code = ?, started_at = ?, finished_at = ?,
                duration_ms = ?, truncated = ?, output_hash = ?, normalized_hash = ?, output = ?, output_trimmed = ?
             WHERE job_id = ? AND position = ?`,
            [
                server.status, server.exitCode, server.signal, server.error, server.errorCode, server.startedAt, server.finishedAt,
                server.durationMs, server.truncated ? 1 : 0, server.outputHash, server.normalizedHash, packOutput(server.stdout, server.stderr),
                server.outputTrimmed ? 1 : 0, jobId, position
            ]
        );
    },

    // Newest first; `before`: the createdAt of the last job of the previous page.
    async list(options: { limit: number; before?: number; active?: boolean }): Promise<MultiExecJobInfo[]> {
        const where: string[] = [];
        const params: unknown[] = [];
        if (options.before !== undefined) {
            where.push("created_at < ?");
            params.push(options.before);
        }
        if (options.active) where.push(`status IN ${ACTIVE}`);
        const rows = await dbAll<JobRow>(
            `SELECT * FROM multiexec_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
            [...params, options.limit]
        );
        const counts = await countsFor(rows.map((row) => row.id));
        return rows.map((row) => toInfo(row, counts.get(row.id) ?? emptyCounts()));
    },

    async get(id: string): Promise<MultiExecJob | null> {
        const row = await dbGet<JobRow>("SELECT * FROM multiexec_jobs WHERE id = ?", [id]);
        if (!row) return null;
        const results = await dbAll<ResultRow>("SELECT * FROM multiexec_job_results WHERE job_id = ? ORDER BY position", [id]);
        const servers = results.map(toServerRun);
        const counts = emptyCounts();
        for (const server of servers) counts[server.status] += 1;
        return { ...toInfo(row, counts), servers };
    },

    async remove(id: string): Promise<boolean> {
        return (await dbRun(`DELETE FROM multiexec_jobs WHERE id = ? AND status NOT IN ${ACTIVE}`, [id])).changes > 0;
    },

    async removeFinished(): Promise<number> {
        return (await dbRun(`DELETE FROM multiexec_jobs WHERE status NOT IN ${ACTIVE}`)).changes;
    },

    // Jobs left running or paused by a previous process: it quit (or died)
    // while they ran. Their servers that were running are marked as
    // interrupted (the command may have run there), those not started as not
    // run, and the audit entries of the commands that were sent (recorded as
    // "running", never completed) as interrupted.
    async markInterrupted(now: number): Promise<number> {
        return transaction(async (tx) => {
            const jobs = await tx.all<{ id: string; created_at: number }>(`SELECT id, created_at FROM multiexec_jobs WHERE status IN ${ACTIVE}`);
            for (const { id, created_at: createdAt } of jobs) {
                await tx.run(
                    `UPDATE multiexec_job_results SET status = 'cancelled', error_code = 'INTERRUPTED', finished_at = ?,
                        duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END
                     WHERE job_id = ? AND status = 'running'`,
                    [now, now, id]
                );
                await tx.run("UPDATE multiexec_job_results SET status = 'skipped' WHERE job_id = ? AND status = 'queued'", [id]);
                await tx.run("UPDATE multiexec_jobs SET status = 'interrupted', pause = NULL, finished_at = ? WHERE id = ?", [now, id]);
                await tx.run(
                    `UPDATE audit_log SET meta = json_set(meta, '$.status', 'interrupted')
                     WHERE ts >= ? AND meta IS NOT NULL AND json_valid(meta) AND json_extract(meta, '$.jobId') = ? AND json_extract(meta, '$.status') = 'running'`,
                    [createdAt, id]
                );
            }
            return jobs.length;
        });
    },

    // Finished jobs older than `before` (epoch ms; null: no age limit) and
    // those beyond the newest `keep` go.
    async prune(before: number | null, keep: number): Promise<number> {
        let removed = 0;
        if (before !== null) {
            removed += (await dbRun(`DELETE FROM multiexec_jobs WHERE status NOT IN ${ACTIVE} AND created_at < ?`, [before])).changes;
        }
        const oldestKept = await dbGet<{ created_at: number }>(
            `SELECT created_at FROM multiexec_jobs WHERE status NOT IN ${ACTIVE} ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
            [Math.max(0, keep - 1)]
        );
        if (oldestKept) {
            removed += (await dbRun(`DELETE FROM multiexec_jobs WHERE status NOT IN ${ACTIVE} AND created_at < ?`, [oldestKept.created_at])).changes;
        }
        return removed;
    }
};
