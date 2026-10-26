import { createHash } from "crypto";
import { CHAT_ERROR_CODES, EVIDENCE_MAX_AGE_MS, type ChatAttachment, type ChatEvidence, type ChatEvidenceAccess, type ChatEvidenceSection } from "../../../shared/chat";
import { MAX_USER_CHARS, attachmentKey, parseChatEvidence } from "../../../shared/chatEvidence";
import type { OpsCapabilities } from "../../../shared/ops";
import { loadConnectionTarget, type SshTarget } from "../../connections/target";
import { AppError, errorMessage } from "../../errors";
import { createLogger } from "../../logger";
import { getCapabilities } from "../../ops/capabilities";
import { connectionError } from "../../ssh/connectionErrors";
import { describeSshError, sshPool, type SshLease } from "../../ssh/pool";
import { containerEvidence } from "./container";
import type { EvidenceContext } from "./context";
import { diskEvidence } from "./disk";
import { fleetEvidence } from "./fleet";
import { checkLogSource, excerptEvidence, logsEvidence } from "./logs";
import { fitEvidence, sectionFailure, textSection } from "./sections";
import { serviceEvidence } from "./service";
import { hasValidSignature, signEvidence } from "./signature";
import { statusEvidence } from "./status";
import { triageEvidence } from "./triage";
// --- W8-T2 Kubernetes ---
import { podEvidence, type PodAttachment } from "../../k8s/evidence";

// The evidence of a diagnosis, collected on the saved server over its pooled
// SSH connection with read-only commands that ShellMind builds from validated
// names (server/ops builders, quoted arguments). Every part is redacted and
// capped; the whole is signed so it can make the round trip through the
// client, which shows the user exactly what the model will read.

const log = createLogger("diagnose");

// The whole collection, whatever its parts (each has its own timeout).
export const EVIDENCE_TIMEOUT_MS = 90_000;

// What names selected log lines in their evidence: a hash of the redacted
// text that goes to the model (nothing of the raw lines can be told from it).
function selectionFingerprint(sections: ChatEvidenceSection[]): string {
    return createHash("sha256").update(sections.map((section) => section.text).join("\n")).digest("base64url").slice(0, 22);
}

// Who a fix would run as: the saved login user (one line, bounded) and its
// rights as the capability check found them.
export function accessOf(username: string, caps: OpsCapabilities): ChatEvidenceAccess {
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    const user = username.replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, MAX_USER_CHARS) || "(unknown)";
    return { platform: caps.platform, user, admin: caps.root, sudo: caps.sudo };
}

// Why the server could not be reached, as the connection reported it, and
// where ShellMind tried to reach it.
export function connectionSection(target: SshTarget, err: unknown): ChatEvidenceSection {
    const { code, message } = connectionError(err);
    const via = target.jump ? `, through the jump host "${target.jump.name}" at ${target.jump.host}:${target.jump.port}` : "";
    const text = [
        "ShellMind could not open an SSH connection to the server, so nothing could be read from it.",
        `Error: ${code}: ${message}`,
        `Address: ${target.host}:${target.port} (SSH${via})`
    ].join("\n");
    return textSection({ id: "connection", title: "Connection to the server", source: `SSH to ${target.host}:${target.port}` }, text, 2000);
}

function gather(ctx: EvidenceContext, attachment: Exclude<ChatAttachment, { kind: "pod" }>): Promise<ChatEvidenceSection[]> {
    switch (attachment.kind) {
        case "service": return serviceEvidence(ctx, attachment.name);
        case "container": return containerEvidence(ctx, attachment.container);
        case "logs": return logsEvidence(ctx, checkLogSource(ctx.caps.platform, attachment.source));
        case "status": return statusEvidence(ctx);
        case "triage": return triageEvidence(ctx);
        // W8-T4 disk toolkit
        case "disk": return diskEvidence(ctx, attachment.mount);
    }
}

export type CollectOptions = { signal?: AbortSignal; now?: () => number };

export async function collectEvidence(serverId: number, attachment: ChatAttachment, options: CollectOptions = {}): Promise<ChatEvidence> {
    const started = Date.now();
    // W8-T2 Kubernetes: kubectl reads a pod's evidence, on the server or (a
    // local kubectl server) on this machine.
    if (attachment.kind === "pod") return collectPodEvidence(serverId, attachment, options, started);
    const target = await loadConnectionTarget(serverId, "exec");
    const timeout = AbortSignal.timeout(EVIDENCE_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let sections: ChatEvidenceSection[];
    let collected = attachment;
    let access: ChatEvidenceAccess | undefined;
    if (attachment.kind === "logs" && attachment.excerpt) {
        // The user's selection is the evidence: nothing runs on the server.
        // The evidence names it by a fingerprint of its redacted text, so the
        // raw lines are not kept with it (in the chat history, a regenerate).
        sections = excerptEvidence(checkLogSource(target.os, attachment.source), attachment.excerpt);
        collected = { kind: "logs", source: attachment.source, selection: selectionFingerprint(sections) };
    } else if (attachment.kind === "logs" && attachment.selection) {
        throw new AppError(CHAT_ERROR_CODES.invalidRequest, "The selected lines are needed again (excerpt): they cannot be collected from their fingerprint.", 400);
    } else {
        let lease: SshLease;
        try {
            lease = await sshPool.acquire(target.serverId);
        } catch (err) {
            // Asked about the server as a whole (its status, a triage: the
            // fleet board's "Ask AI" on a server that is down), the failed
            // connection is the evidence: the user can still ask why.
            if ((attachment.kind !== "status" && attachment.kind !== "triage") || signal.aborted) throw err;
            // With what the fleet board last read of it, dated (its age is said).
            const collectedAt = (options.now ?? Date.now)();
            const fleet = await fleetEvidence(serverId, collectedAt).catch((fleetErr: unknown) => {
                log.warn(`The fleet reading of server #${serverId} could not be read: ${errorMessage(fleetErr)}`);
                return null;
            });
            const evidence = signEvidence({ serverId, attachment, collectedAt, sections: fleet ? [connectionSection(target, err), fleet] : [connectionSection(target, err)] });
            log.debug(`Server #${serverId} could not be reached for its ${attachment.kind} evidence: ${describeSshError(err)}`);
            return evidence;
        }
        try {
            const caps = await getCapabilities(lease, target.os, { signal });
            access = accessOf(target.username, caps);
            sections = await gather({ serverId, lease, caps, signal }, attachment);
        } catch (err) {
            if (timeout.aborted && !options.signal?.aborted) {
                throw new AppError("EXEC_TIMEOUT", `Collecting the evidence took longer than ${EVIDENCE_TIMEOUT_MS / 1000} s.`, 504);
            }
            throw err;
        } finally {
            lease.release();
        }
    }

    return sealEvidence(serverId, collected, sections, access, options, started);
}

// The collected parts as signed evidence.
function sealEvidence(
    serverId: number,
    attachment: ChatAttachment,
    sections: ChatEvidenceSection[],
    access: ChatEvidenceAccess | undefined,
    options: CollectOptions,
    started: number
): ChatEvidence {
    // Nothing could be read: an error says more than an empty diagnosis.
    // details.sections: each part's id, error code and reason (the client
    // words them in its language; the reason is the server's own text).
    const failed = sections.filter((section) => section.failed);
    if (sections.length && failed.length === sections.length) {
        throw new AppError(
            "EVIDENCE_UNAVAILABLE",
            `None of the evidence could be read. ${failed.map((section) => `${section.title}: ${section.text}`).join(" ")}`.slice(0, 1000),
            502,
            { sections: failed.map((section) => ({ id: section.id, ...sectionFailure(section) })) }
        );
    }

    const evidence = signEvidence({ serverId, attachment, collectedAt: (options.now ?? Date.now)(), sections: fitEvidence(sections), ...(access ? { access } : {}) });
    log.debug(`Collected ${attachment.kind} evidence of server #${serverId}: ${sections.length} sections, ${sections.reduce((sum, s) => sum + s.text.length, 0)} characters in ${Date.now() - started} ms.`);
    return evidence;
}

// --- W8-T2 Kubernetes ---
async function collectPodEvidence(serverId: number, attachment: PodAttachment, options: CollectOptions, started: number): Promise<ChatEvidence> {
    const timeout = AbortSignal.timeout(EVIDENCE_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
        const { sections, access } = await podEvidence(serverId, attachment, signal);
        return sealEvidence(serverId, attachment, sections, access, options, started);
    } catch (err) {
        if (timeout.aborted && !options.signal?.aborted) {
            throw new AppError("EXEC_TIMEOUT", `Collecting the evidence took longer than ${EVIDENCE_TIMEOUT_MS / 1000} s.`, 504);
        }
        throw err;
    }
}

const expired = (message: string) => new AppError(CHAT_ERROR_CODES.evidenceExpired, message, 409);

// Evidence a client sent back: well formed, for this server and attachment,
// signed by this process and recent. Otherwise it must be collected again.
export function verifyEvidence(value: unknown, serverId: number, attachment: ChatAttachment, now = Date.now()): ChatEvidence {
    const evidence = parseChatEvidence(value);
    if (!evidence) throw new AppError(CHAT_ERROR_CODES.invalidRequest, "evidence is malformed.", 400);
    if (evidence.serverId !== serverId || attachmentKey(evidence.attachment) !== attachmentKey(attachment)) {
        throw new AppError(CHAT_ERROR_CODES.invalidRequest, "evidence belongs to another server or attachment.", 400);
    }
    if (!hasValidSignature(evidence)) throw expired("The evidence was collected before ShellMind restarted (or was changed). Collect it again.");
    if (now - evidence.collectedAt > EVIDENCE_MAX_AGE_MS || evidence.collectedAt - now > 60_000) {
        throw expired("The evidence is too old to diagnose. Collect it again.");
    }
    return evidence;
}
