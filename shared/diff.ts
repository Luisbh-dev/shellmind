// Line diff (Myers' O(ND) algorithm) for comparing command outputs: what a
// server printed against what the majority printed. Pure and dependency-free
// so the browser and the backend can both use it. Common leading and
// trailing lines are set aside first; past `maxEdits` differences the middle
// is reported as replaced wholesale (`coarse`), which keeps the cost bounded
// for outputs that have nothing in common.

export type DiffOp = {
    type: "equal" | "add" | "remove";
    text: string;
    // 1-based line numbers in the old / new text (null on the side the line is not in).
    oldLine: number | null;
    newLine: number | null;
};

export type LineDiff = {
    ops: DiffOp[];
    added: number;
    removed: number;
    // The texts differed too much for an exact diff: the differing middle is
    // shown as removed then added.
    coarse: boolean;
};

export type DiffHunk = {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    ops: DiffOp[];
};

export const DIFF_DEFAULT_MAX_EDITS = 1000;

// Lines of a text; one final newline does not make an empty last line, and
// CRLF counts as LF.
export function splitLines(text: string): string[] {
    if (text === "") return [];
    const normalized = text.replace(/\r\n?/g, "\n");
    return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

type Move = "equal" | "add" | "remove";

// The edit script between a and b, or null when it needs more than maxEdits
// insertions and deletions.
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Move[] | null {
    const n = a.length;
    const m = b.length;
    const limit = Math.min(maxEdits, n + m);
    const offset = limit + 1;
    const v = new Int32Array(2 * limit + 3);
    // trace[d]: v[k] for k in [-d-1, d+1] as it was when step d began.
    const trace: Int32Array[] = [];
    v[offset + 1] = 0;
    for (let d = 0; d <= limit; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, n, m);
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Move[] {
    const moves: Move[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const snapshot = trace[d];
        const at = (k: number) => snapshot[k + d + 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            moves.push("equal");
            x--;
            y--;
        }
        if (d === 0) break;
        if (x === prevX) {
            moves.push("add");
            y--;
        } else {
            moves.push("remove");
            x--;
        }
    }
    return moves.reverse();
}

export function diffLines(oldText: string, newText: string, options: { maxEdits?: number } = {}): LineDiff {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const middleA = a.slice(start, endA);
    const middleB = b.slice(start, endB);
    let moves = myers(middleA, middleB, options.maxEdits ?? DIFF_DEFAULT_MAX_EDITS);
    const coarse = moves === null;
    if (!moves) moves = [...middleA.map((): Move => "remove"), ...middleB.map((): Move => "add")];

    const ops: DiffOp[] = [];
    let oldLine = 0;
    let newLine = 0;
    const push = (type: Move, text: string) => {
        if (type !== "add") oldLine++;
        if (type !== "remove") newLine++;
        ops.push({ type, text, oldLine: type === "add" ? null : oldLine, newLine: type === "remove" ? null : newLine });
    };
    for (let i = 0; i < start; i++) push("equal", a[i]);
    let ia = start;
    let ib = start;
    for (const move of moves) {
        if (move === "equal") {
            push("equal", a[ia]);
            ia++;
            ib++;
        } else if (move === "remove") {
            push("remove", a[ia]);
            ia++;
        } else {
            push("add", b[ib]);
            ib++;
        }
    }
    for (let i = endA; i < a.length; i++) push("equal", a[i]);

    return {
        ops,
        added: ops.filter((op) => op.type === "add").length,
        removed: ops.filter((op) => op.type === "remove").length,
        coarse
    };
}

// The changed parts of a diff with `context` unchanged lines around them;
// changes closer than twice the context share a hunk.
export function diffHunks(ops: readonly DiffOp[], context = 3): DiffHunk[] {
    const changed = ops.map((op, index) => (op.type === "equal" ? -1 : index)).filter((index) => index >= 0);
    if (changed.length === 0) return [];
    const ranges: Array<[number, number]> = [];
    for (const index of changed) {
        const from = Math.max(0, index - context);
        const to = Math.min(ops.length - 1, index + context);
        const last = ranges[ranges.length - 1];
        if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
        else ranges.push([from, to]);
    }
    return ranges.map(([from, to]) => {
        const slice = ops.slice(from, to + 1);
        const firstOld = slice.find((op) => op.oldLine !== null)?.oldLine ?? null;
        const firstNew = slice.find((op) => op.newLine !== null)?.newLine ?? null;
        // A hunk with no line on one side starts after the line before it.
        const before = ops.slice(0, from);
        const oldBefore = before.filter((op) => op.oldLine !== null).length;
        const newBefore = before.filter((op) => op.newLine !== null).length;
        return {
            oldStart: firstOld ?? oldBefore,
            oldLines: slice.filter((op) => op.oldLine !== null).length,
            newStart: firstNew ?? newBefore,
            newLines: slice.filter((op) => op.newLine !== null).length,
            ops: slice
        };
    });
}
