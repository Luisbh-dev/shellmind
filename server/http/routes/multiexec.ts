import { Router, type Request, type Response } from "express";
import type { MultiExecJobEvent } from "../../../shared/multiexec";
import { AppError } from "../../errors";
import { createLogger } from "../../logger";
import { backendJobManager, createJobManager, type JobManager, type JobManagerOptions } from "../../multiexec/jobs";
import { isJobId, parseJobRequest } from "../../multiexec/request";
import { jsonBody, sendError } from "../respond";
import { createSseStream } from "../sse";

// Multi-exec jobs. POST /api/multiexec starts one and answers right away
// with its id; the job runs on the backend from then on, whether or not a
// client follows it. GET .../events streams it (a snapshot, then its live
// events) as Server-Sent Events and can be reopened at any time; closing the
// stream does not affect the job. Jobs are cancelled explicitly.

const log = createLogger("multiexec");

const PING_INTERVAL_MS = 15_000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

function jobIdOf(req: Request): string {
    const { id } = req.params;
    if (!isJobId(id)) throw new AppError("MULTIEXEC_JOB_NOT_FOUND", "This job does not exist (it may have been deleted).", 404);
    return id;
}

function listQuery(req: Request): { limit: number; before?: number; active?: boolean } {
    const number = (value: unknown, name: string, max: number) => {
        if (value === undefined || value === "") return undefined;
        const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new AppError("INVALID_MULTIEXEC", `${name} must be a positive integer up to ${max}`);
        return parsed;
    };
    return {
        limit: number(req.query.limit, "limit", LIST_MAX) ?? LIST_DEFAULT,
        before: number(req.query.before, "before", Number.MAX_SAFE_INTEGER),
        active: req.query.active === "1" || req.query.active === "true" ? true : undefined
    };
}

export function createMultiExecRouter(options: JobManagerOptions & { jobs?: JobManager } = {}): Router {
    const router = Router();
    const jobs = options.jobs ?? (options.deps || options.limits ? createJobManager(options) : backendJobManager());

    // Body: MultiExecRequest. Answers {data: {job}} once the job is created.
    router.post("/api/multiexec", async (req, res) => {
        // A client that leaves while the request is checked gets no job: it
        // never learned it started.
        let left = false;
        const onClose = () => {
            if (!res.writableEnded) left = true;
        };
        res.once("close", onClose);
        try {
            const request = await parseJobRequest(jsonBody(req));
            if (left) {
                log.debug("The client left before the job started");
                return;
            }
            const job = await jobs.start(request);
            res.status(201).json({ message: "started", data: { job } });
        } catch (err) {
            if (!left) sendError(res, err, "POST /api/multiexec");
        } finally {
            res.off("close", onClose);
        }
    });

    // ?limit=&before=<createdAt of the last job of the previous page>&active=1
    router.get("/api/multiexec/jobs", async (req, res) => {
        try {
            res.json({ message: "success", data: await jobs.list(listQuery(req)) });
        } catch (err) {
            sendError(res, err, "GET /api/multiexec/jobs");
        }
    });

    // Removes every finished job from the history.
    router.delete("/api/multiexec/jobs", async (_req, res) => {
        try {
            res.json({ message: "deleted", data: { deleted: await jobs.clearFinished() } });
        } catch (err) {
            sendError(res, err, "DELETE /api/multiexec/jobs");
        }
    });

    router.get("/api/multiexec/jobs/:id", async (req, res) => {
        try {
            const job = await jobs.get(jobIdOf(req));
            if (!job) throw new AppError("MULTIEXEC_JOB_NOT_FOUND", "This job does not exist (it may have been deleted).", 404);
            res.json({ message: "success", data: job });
        } catch (err) {
            sendError(res, err, "GET /api/multiexec/jobs/:id");
        }
    });

    router.get("/api/multiexec/jobs/:id/events", async (req, res) => {
        let id: string;
        try {
            id = jobIdOf(req);
        } catch (err) {
            sendError(res, err, "GET /api/multiexec/jobs/:id/events");
            return;
        }
        let unsubscribe: (() => void) | null = null;
        let ping: NodeJS.Timeout | null = null;
        const close = () => {
            unsubscribe?.();
            unsubscribe = null;
            if (ping) clearInterval(ping);
            ping = null;
        };
        const sse = createSseStream(res, close);
        try {
            let ended = false;
            const listener = (event: MultiExecJobEvent) => {
                if (!sse.started()) sse.start();
                sse.send(event);
                if (event.type === "end") {
                    ended = true;
                    close();
                    sse.end();
                }
            };
            unsubscribe = await jobs.follow(id, listener);
            if (!unsubscribe) throw new AppError("MULTIEXEC_JOB_NOT_FOUND", "This job does not exist (it may have been deleted).", 404);
            if (ended) {
                close();
                return;
            }
            if (res.writableEnded || res.destroyed) {
                close();
                return;
            }
            ping = setInterval(() => sse.send({ type: "ping" } satisfies MultiExecJobEvent), PING_INTERVAL_MS);
            ping.unref?.();
        } catch (err) {
            close();
            sendError(res, err, "GET /api/multiexec/jobs/:id/events");
        }
    });

    const control = (action: "pause" | "resume" | "cancel") => async (req: Request, res: Response) => {
        try {
            res.json({ message: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "resumed", data: await jobs[action](jobIdOf(req)) });
        } catch (err) {
            sendError(res, err, `POST /api/multiexec/jobs/:id/${action}`);
        }
    };
    router.post("/api/multiexec/jobs/:id/pause", control("pause"));
    // Also the approval of a job waiting after its canary.
    router.post("/api/multiexec/jobs/:id/resume", control("resume"));
    // Cancels the commands still running and every server not started yet.
    router.post("/api/multiexec/jobs/:id/cancel", control("cancel"));

    router.delete("/api/multiexec/jobs/:id", async (req, res) => {
        try {
            await jobs.remove(jobIdOf(req));
            res.json({ message: "deleted" });
        } catch (err) {
            sendError(res, err, "DELETE /api/multiexec/jobs/:id");
        }
    });

    return router;
}
