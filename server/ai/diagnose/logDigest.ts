// Log lines as the model reads them in a diagnosis: a run of lines that only
// differ in their numbers, ids, addresses or timestamps ("upstream timed
// out" 40 times) becomes its first and last line plus a count, and when the
// result is still too long the latest lines are kept, with the most frequent
// patterns of the left-out part summarized. Order is preserved: the sequence
// of events before a failure is what matters.

// Parts of a line that change between repetitions of the same message.
const TIMESTAMPS = [
    // ISO-8601 (journalctl -o short-iso, docker logs --timestamps).
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    // syslog.
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2}\b/g
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
// Numbers, and hex ids of 6 characters or more (words such as "eth0" stay).
const NUMBER = /\b(?:0x)?[0-9a-f]*\d[0-9a-f]*\b/gi;

export function lineTemplate(line: string): string {
    let template = line;
    for (const pattern of TIMESTAMPS) template = template.replace(pattern, "<ts>");
    template = template
        .replace(UUID, "<uuid>")
        .replace(IP, "<ip>")
        .replace(NUMBER, (match) => (/^\d+$/.test(match) || match.length >= 6 || /^0x/i.test(match) ? "<n>" : match));
    return template.replace(/\s+/g, " ").trim();
}

type Run = { first: string; last: string; count: number; template: string };

function runsOf(lines: string[]): Run[] {
    const runs: Run[] = [];
    for (const line of lines) {
        const template = lineTemplate(line);
        const current = runs[runs.length - 1];
        if (current && current.template === template && template) {
            current.count += 1;
            current.last = line;
        } else {
            runs.push({ first: line, last: line, count: 1, template });
        }
    }
    return runs;
}

// A run keeps its first and last line (the numbers that changed between
// them often matter: "retry 1/40" ... "retry 40/40").
function renderRun(run: Run): string {
    if (run.count === 1) return run.first;
    if (run.count === 2) return `${run.first}\n${run.last}`;
    const between = run.count - 2;
    return `${run.first}\n  [... ${between} similar line${between === 1 ? "" : "s"}]\n${run.last}`;
}

export type LogDigest = {
    text: string;
    // Lines of the log, those left out before `raw` included.
    lines: number;
    // Some lines were left out (beyond the folding of repeats).
    truncated: boolean;
};

const MAX_PATTERNS = 5;

// `maxChars`: the most the result may hold. `earlier`: lines before `raw`
// that were left out already (the summary counts them).
export function digestLog(raw: string, maxChars: number, earlier = 0): LogDigest {
    const lines = raw.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const runs = runsOf(lines);
    const rendered = runs.map(renderRun);

    const full = rendered.join("\n");
    if (full.length <= maxChars && !earlier) return { text: full, lines: lines.length, truncated: false };

    // The latest runs that fit, after room for the summary of the others.
    const summaryBudget = Math.min(1200, Math.floor(maxChars * 0.15));
    let used = 0;
    let start = rendered.length;
    while (start > 0 && used + rendered[start - 1].length + 1 <= maxChars - summaryBudget) {
        start -= 1;
        used += rendered[start].length + 1;
    }
    const kept = rendered.slice(start);
    // A single huge line: keep its end.
    if (!kept.length) kept.push(rendered[rendered.length - 1].slice(-(maxChars - summaryBudget)));

    const omitted = runs.slice(0, start);
    const omittedLines = omitted.reduce((sum, run) => sum + run.count, earlier);
    const counts = new Map<string, { count: number; sample: string }>();
    for (const run of omitted) {
        const entry = counts.get(run.template) ?? { count: 0, sample: run.first };
        entry.count += run.count;
        counts.set(run.template, entry);
    }
    const frequent = [...counts.values()].filter((entry) => entry.count > 1).sort((a, b) => b.count - a.count).slice(0, MAX_PATTERNS);
    const header = [`[... ${omittedLines} earlier line${omittedLines === 1 ? "" : "s"} left out${frequent.length ? "; the most frequent of them:" : ""}]`];
    for (const entry of frequent) header.push(`  ${entry.count}x ${entry.sample.slice(0, 200)}`);
    const summary = header.join("\n").slice(0, summaryBudget);

    return { text: `${summary}\n${kept.join("\n")}`.slice(-maxChars), lines: lines.length + earlier, truncated: true };
}
