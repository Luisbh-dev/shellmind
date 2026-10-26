// Grouping the servers of a multi-exec job by what they printed: "38
// identical, 2 different". The backend hashes each server's whole output when
// it finishes (the job history keeps only the start of it), once exactly and
// once normalized: line endings and trailing spaces evened out, and the
// values that differ from host to host on their own (its name and address,
// dates, times, PIDs) masked. The UI groups by either hash.

import type { MultiExecErrorCode, MultiExecStatus } from "./multiexec";
import { trimTrailingNewlines } from "./text";

// cyrb53 (public domain): a fast 53-bit string hash, plenty for telling a few
// hundred outputs apart. Not cryptographic.
export function hashText(text: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

// Applied in order: whole timestamps before their date and time parts.
const VOLATILE: Array<[RegExp, string]> = [
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
    [/\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/g, "<date>"],
    [/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, "<date>"],
    [new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, "g"), "<date>"],
    [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\b/g, "<time>"],
    [/\b(pid|PID|Pid)(\s*[=:]\s*|\s+)\d+/g, "$1$2<pid>"],
    [/\[\d+\]/g, "[<pid>]"]
];

// `hostname`: what the server calls itself (the backend asks it), which can
// differ from the name it was saved under.
export type HostTerms = { name: string; host: string; hostname?: string | null };

const firstLabel = (name: string) => (/^[a-z][\w-]*\./i.test(name) ? name.split(".")[0] : "");

// The words that name the server itself: its saved name, its address, its
// own host name and, for DNS names, their first label.
function hostTerms({ name, host, hostname }: HostTerms): string[] {
    const terms = new Set<string>();
    for (const term of [name, host, firstLabel(host), hostname ?? "", firstLabel(hostname ?? "")]) {
        if (term.trim().length >= 2) terms.add(term.trim());
    }
    return [...terms].sort((a, b) => b.length - a.length);
}

// The output with host-specific and time-dependent values masked.
export function normalizeOutput(text: string, server: HostTerms): string {
    let result = trimTrailingNewlines(text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n"));
    for (const term of hostTerms(server)) {
        result = result.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(term)}(?![\\w-])`, "gi"), "<host>");
    }
    for (const [pattern, replacement] of VOLATILE) result = result.replace(pattern, replacement);
    return result;
}

export function outputHashes(stdout: string, stderr: string, server: HostTerms): { outputHash: string; normalizedHash: string } {
    return {
        outputHash: hashText(`${stdout}\u0000${stderr}`),
        normalizedHash: hashText(`${normalizeOutput(stdout, server)}\u0000${normalizeOutput(stderr, server)}`)
    };
}

export type GroupableRun = {
    serverId: number;
    status: MultiExecStatus;
    exitCode: number | null;
    errorCode: MultiExecErrorCode | null;
    outputHash: string | null;
    normalizedHash: string | null;
};

export type OutputGroup<T extends GroupableRun> = {
    key: string;
    // output: these servers ran the command and printed the same (with the
    // same exit code); none: they have no output to compare (they did not
    // run, or could not connect) and are grouped by what happened.
    kind: "output" | "none";
    status: MultiExecStatus;
    exitCode: number | null;
    errorCode: MultiExecErrorCode | null;
    members: T[];
};

export type GroupMode = "exact" | "normalized";

// Groups of the finished servers, largest first (the first output group is
// the majority the others are compared with). Servers still queued or
// running are left out.
//
// Normalized mode never splits what exact mode puts together: masking only
// touches a server's own name, address and host name, which can be a word
// of everyone's output ("ubuntu", "nginx"), so the same bytes can give two
// normalized hashes. Normalized groups that share an exact output are one
// group (the history keeps both hashes, so this also holds for older jobs).
export function groupByOutput<T extends GroupableRun>(runs: readonly T[], mode: GroupMode): Array<OutputGroup<T>> {
    const finished = runs.filter((run) => run.status !== "queued" && run.status !== "running");
    const keyOf = (run: T, hash: string | null) => (hash ? `output:${hash}:${run.exitCode ?? ""}:${run.status}` : `none:${run.status}:${run.errorCode ?? ""}`);
    const parent = new Map<string, string>();
    const root = (key: string): string => {
        let current = key;
        while (parent.get(current) !== current) current = parent.get(current)!;
        parent.set(key, current);
        return current;
    };
    const exactOwner = new Map<string, string>();
    for (const run of finished) {
        const key = keyOf(run, mode === "exact" ? run.outputHash : run.normalizedHash);
        if (!parent.has(key)) parent.set(key, key);
        if (mode === "exact" || !run.outputHash || !run.normalizedHash) continue;
        const exact = keyOf(run, run.outputHash);
        const owner = exactOwner.get(exact);
        if (!owner) exactOwner.set(exact, key);
        else if (root(owner) !== root(key)) parent.set(root(key), root(owner));
    }

    const groups = new Map<string, OutputGroup<T>>();
    for (const run of finished) {
        const hash = mode === "exact" ? run.outputHash : run.normalizedHash;
        const kind = hash ? "output" : "none";
        const key = root(keyOf(run, hash));
        const group = groups.get(key);
        if (group) group.members.push(run);
        else groups.set(key, { key, kind, status: run.status, exitCode: run.exitCode, errorCode: run.errorCode, members: [run] });
    }
    return [...groups.values()].sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "output" ? -1 : 1) || b.members.length - a.members.length);
}
