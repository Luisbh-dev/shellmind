import type { ChatEvidenceSection } from "../../../shared/chat";
import { isValidLogPath, normalizeUnitName, type LogSource, type OpsPlatform } from "../../../shared/ops";
import { containerLogs, requireContainerRef, requireEngine } from "../../ops/containers";
import { commandFailure, psQuote, runPosixScript, runPowerShell, shellQuote } from "../../ops/remote";
import { InvalidOpsInputError, OpsUnsupportedError, privileged, readJournal, requireServiceName } from "../../ops/services";
import { EVIDENCE_COMMAND_TIMEOUT_MS, EVIDENCE_OUTPUT_MAX_BYTES, EVIDENCE_LOG_LINES, type EvidenceContext } from "./context";
import { attempt, logSection, readableJournal } from "./sections";

// A log source of the Logs panel: its last lines, read once (the panel's
// live commands follow forever), or the lines the user selected there.

const LOG_CHARS = 16_000;

// The source as validated for the server's platform (the same rules as the
// live log panel, server/ops/logs.ts).
export function checkLogSource(platform: OpsPlatform, source: LogSource): LogSource {
    switch (source.kind) {
        case "journal":
            if (platform === "windows") throw new OpsUnsupportedError("Windows servers have no systemd journal.");
            return source.unit ? { kind: "journal", unit: requireServiceName("linux", normalizeUnitName(source.unit)) } : { kind: "journal" };
        case "file":
            if (!isValidLogPath(platform, source.path)) throw new InvalidOpsInputError("The log file must be an absolute path.");
            return source;
        case "container":
            return { kind: "container", container: requireContainerRef(source.container) };
    }
}

export function describeLogSource(source: LogSource): string {
    if (source.kind === "journal") return source.unit ? `the journal of ${source.unit}` : "the system journal";
    if (source.kind === "file") return source.path;
    return `the logs of container ${source.container}`;
}

// "~/x" is the login user's home; only the validated rest is quoted.
function posixPath(path: string): string {
    return path.startsWith("~/") ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
}

// The path is validated, and quoted even so (psQuote).
export function windowsTailScript(path: string, lines: number): string {
    return `
$ErrorActionPreference='Stop'
try{Get-Content -LiteralPath ${psQuote(path)} -Tail ${lines}}catch{[Console]::Out.WriteLine($_.Exception.Message);exit 1}
`;
}

async function readSource(ctx: EvidenceContext, source: LogSource): Promise<{ text: string; command: string }> {
    const { lease, caps, signal } = ctx;
    const lines = EVIDENCE_LOG_LINES;
    switch (source.kind) {
        case "journal": {
            if (!caps.journal) throw new OpsUnsupportedError("This server has no systemd journal.");
            if (source.unit) return { text: readableJournal(await readJournal(lease, caps, source.unit, lines, signal)), command: `journalctl -u ${source.unit} -n ${lines}` };
            const command = `${privileged(caps)}journalctl -n ${lines} --no-pager -o short-iso 2>&1`;
            const result = await runPosixScript(lease, `${command}\n`, { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.linux, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
            if (result.code !== 0 && !result.stdout.trim()) throw commandFailure(result, "journalctl failed");
            return { text: readableJournal(result.stdout), command: `journalctl -n ${lines}` };
        }
        case "file": {
            if (caps.platform === "windows") {
                const result = await runPowerShell(lease, windowsTailScript(source.path, lines), { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.windows, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
                if (result.code !== 0) throw commandFailure({ ...result, stderr: result.stdout }, "Get-Content failed");
                return { text: result.stdout, command: `Get-Content -Tail ${lines} ${source.path}` };
            }
            const result = await runPosixScript(lease, `${privileged(caps)}tail -n ${lines} -- ${posixPath(source.path)}\n`, { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.linux, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
            if (result.code !== 0) throw commandFailure(result, "tail failed");
            return { text: result.stdout, command: `tail -n ${lines} ${source.path}` };
        }
        case "container": {
            const { engine } = requireEngine(caps);
            return { text: await containerLogs(lease, caps, source.container, lines, signal, EVIDENCE_OUTPUT_MAX_BYTES), command: `${engine} logs --tail ${lines} --timestamps ${source.container}` };
        }
    }
}

export async function logsEvidence(ctx: EvidenceContext, source: LogSource): Promise<ChatEvidenceSection[]> {
    const base = { id: "logs" as const, title: `Last ${EVIDENCE_LOG_LINES} lines of ${describeLogSource(source)}` };
    const section = await attempt(base, ctx.signal, async () => {
        const { text, command } = await readSource(ctx, source);
        return logSection({ ...base, source: command }, text, LOG_CHARS);
    });
    return [section];
}

// The lines the user selected: no command runs on the server.
export function excerptEvidence(source: LogSource, excerpt: string): ChatEvidenceSection[] {
    return [logSection({ id: "excerpt", title: `Lines the user selected in the Logs panel (${describeLogSource(source)})` }, excerpt, LOG_CHARS)];
}
