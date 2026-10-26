import { MAX_EVIDENCE_CHARS, MAX_EVIDENCE_SECTION_CHARS, type ChatEvidenceSection, type ChatEvidenceSectionId } from "../../../shared/chat";
import { AppError, errorMessage } from "../../errors";
import { ExecAbortedError } from "../../ssh/exec";
import { redactClipped, redactSecrets } from "../redact";
import { clipMiddle, clipShares } from "../untrusted";
import { digestLog } from "./logDigest";

// The parts of the evidence: every text is redacted before anything else
// sees it, then capped (logs keep their latest lines, other text its head
// and tail). A part that cannot be read becomes a "failed" section that says
// why, so the model knows what it is missing.

export type SectionBase = { id: ChatEvidenceSectionId; title: string; source?: string };

const NO_OUTPUT = "(no output)";

const budget = (maxChars: number) => Math.min(maxChars, MAX_EVIDENCE_SECTION_CHARS);

// What a log part masks and digests at most, from its end: far more than
// it keeps (the digest folds repeated lines and sums up those it leaves
// out), but bounded, so that 4 MB of output cost no more than this. A longer
// line keeps its start and its end.
const LOG_WINDOW_CHARS = 128 * 1024;
const MAX_LOG_LINE_CHARS = 4096;

// A line shortened to MAX_LOG_LINE_CHARS. Each end stops before the word the
// cut splits: half a secret, without the name before it or its other half,
// would no longer look like one.
function clipLine(line: string): string {
    if (line.length <= MAX_LOG_LINE_CHARS) return line;
    const { head, tail } = clipShares(MAX_LOG_LINE_CHARS);
    let headEnd = head;
    while (headEnd > 0 && !/\s/.test(line[headEnd - 1])) headEnd -= 1;
    let tailStart = line.length - tail;
    while (tailStart < line.length && !/\s/.test(line[tailStart])) tailStart += 1;
    return `${line.slice(0, headEnd)}[... ${tailStart - headEnd} characters omitted ...]${line.slice(tailStart)}`;
}

// The latest lines of a log that fit in LOG_WINDOW_CHARS, and how many
// earlier ones were left out.
function logWindow(raw: string): { text: string; earlier: number; clipped: boolean } {
    const text = raw.replace(/\r\n?/g, "\n");
    const kept: string[] = [];
    let used = 0;
    let clipped = false;
    // From the last line back; `end` is where the next line to read ends.
    let end = text.length;
    while (end >= 0) {
        const start = end > 0 ? text.lastIndexOf("\n", end - 1) + 1 : 0;
        const original = text.slice(start, end);
        const line = clipLine(original);
        if (kept.length && used + line.length + 1 > LOG_WINDOW_CHARS) break;
        if (line !== original) clipped = true;
        kept.push(line);
        used += line.length + 1;
        end = start - 1;
    }
    let earlier = 0;
    if (end >= 0) {
        earlier = 1;
        for (let at = text.indexOf("\n"); at >= 0 && at < end; at = text.indexOf("\n", at + 1)) earlier += 1;
    }
    return { text: kept.reverse().join("\n"), earlier, clipped };
}

export function textSection(base: SectionBase, raw: string, maxChars: number): ChatEvidenceSection {
    const clipped = redactClipped(raw.replace(/\r\n?/g, "\n").trim(), budget(maxChars));
    return { ...base, text: clipped.text.trim() || NO_OUTPUT, ...(clipped.clipped ? { truncated: true } : {}) };
}

export function logSection(base: SectionBase, raw: string, maxChars: number): ChatEvidenceSection {
    const window = logWindow(raw);
    const digest = digestLog(redactSecrets(window.text), budget(maxChars), window.earlier);
    return { ...base, text: digest.text.trim() ? digest.text : NO_OUTPUT, ...(digest.truncated || window.clipped ? { truncated: true } : {}) };
}

export function failedSection(base: SectionBase, err: unknown): ChatEvidenceSection {
    const code = err instanceof AppError ? ` (${err.code})` : "";
    const reason = redactSecrets(errorMessage(err)).slice(0, 1000) || "Unknown error";
    return { ...base, text: `Could not be read${code}: ${reason}`, failed: true };
}

// Why a failed section could not be read (the parts of its text above), for
// a client to word in its own language.
export function sectionFailure(section: ChatEvidenceSection): { code: string | null; reason: string } {
    const match = /^Could not be read(?: \(([A-Z][A-Z0-9_]*)\))?: ([\s\S]*)$/.exec(section.text);
    return match ? { code: match[1] ?? null, reason: match[2] } : { code: null, reason: section.text };
}

// What journalctl prints, exiting 0, for a user who may not read the system
// journal: nothing else, "-- No entries --", or only the user's own messages.
const JOURNAL_DENIED = /No journal files were opened due to insufficient permissions|You are currently not seeing messages from other users and the system/i;

export const JOURNAL_DENIED_REASON = "The login user may not read the system journal: that needs root, passwordless sudo, or membership in the systemd-journal (or adm) group.";

export const WINDOWS_SERVICES_DENIED_REASON = "The login user may not list the services: over SSH Windows lets only administrators do that.";

export const WINDOWS_EVENTLOG_DENIED_REASON = "The login user may not read the System and Application event logs: over SSH that needs an administrator or a member of Event Log Readers.";

// journalctl output, or a permission error when it says that it showed
// nothing of the system journal (which would read as "no errors").
export function readableJournal(output: string): string {
    if (JOURNAL_DENIED.test(output)) throw new AppError("OPS_PERMISSION_DENIED", JOURNAL_DENIED_REASON, 403);
    return output;
}

// Failures that end the whole collection rather than one part of it: the
// request was abandoned, or the connection itself is gone.
function isFatal(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted || err instanceof ExecAbortedError) return true;
    if (!(err instanceof AppError)) return true;
    return err.code === "SSH_CLOSED" || err.code === "SSH_CHANNEL_REFUSED" || err.code === "OPS_INVALID_INPUT";
}

// Runs one part; a command that fails (permission denied, a timeout, no
// such unit) becomes a failed section instead of failing the rest.
export async function attempt(base: SectionBase, signal: AbortSignal | undefined, read: () => Promise<ChatEvidenceSection>): Promise<ChatEvidenceSection> {
    try {
        return await read();
    } catch (err) {
        if (isFatal(err, signal)) throw err;
        return failedSection(base, err);
    }
}

// Safety net over the per-section budgets: the whole stays within
// MAX_EVIDENCE_CHARS, the largest sections giving up the most.
export function fitEvidence(sections: ChatEvidenceSection[], maxChars = MAX_EVIDENCE_CHARS): ChatEvidenceSection[] {
    let total = sections.reduce((sum, section) => sum + section.text.length, 0);
    if (total <= maxChars) return sections;
    const fitted = sections.map((section) => ({ ...section }));
    for (let round = 0; total > maxChars && round < 50; round++) {
        const largest = fitted.reduce((max, section) => (section.text.length > max.text.length ? section : max));
        const excess = total - maxChars;
        const target = Math.max(200, largest.text.length - Math.max(excess, Math.ceil(largest.text.length * 0.2)));
        if (target >= largest.text.length) break;
        const before = largest.text.length;
        largest.text = clipMiddle(largest.text, target).text;
        largest.truncated = true;
        total -= before - largest.text.length;
    }
    return fitted;
}
