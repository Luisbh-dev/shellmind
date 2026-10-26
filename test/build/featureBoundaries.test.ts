import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// arch-feature-cycles: the operations panels imported the status dashboard's
// internals while the dashboard imported theirs (and the same between known
// hosts and tunnels, snippets and multi-exec, audit and multi-exec). The
// features below reach each other only through a public.ts (ESLint enforces
// it per import) and none of them may be part of an import cycle between
// features, which that rule alone cannot see.

const BOUNDED = ['audit', 'knownHosts', 'multiexec', 'ops', 'snippets', 'status', 'tunnels'];

const featuresDir = fileURLToPath(new URL('../../src/features', import.meta.url));

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
}

// Feature -> the other features its (non-test) modules import, statically or lazily.
function featureGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    const specifier = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const file of sourceFiles(featuresDir)) {
        const feature = path.relative(featuresDir, file).split(path.sep)[0];
        const targets = graph.get(feature) ?? new Set<string>();
        graph.set(feature, targets);
        for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(specifier)) {
            let target: string | undefined;
            if (spec.startsWith('@/features/')) target = spec.split('/')[2];
            else if (spec.startsWith('.')) {
                const resolved = path.relative(featuresDir, path.resolve(path.dirname(file), spec));
                if (!resolved.startsWith('..')) target = resolved.split(path.sep)[0];
            }
            if (target && target !== feature) targets.add(target);
        }
    }
    return graph;
}

function reaches(graph: Map<string, Set<string>>, from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
        const current = stack.pop() as string;
        for (const next of graph.get(current) ?? []) {
            if (next === to) return true;
            if (!seen.has(next)) {
                seen.add(next);
                stack.push(next);
            }
        }
    }
    return false;
}

describe('feature boundaries', () => {
    it('keeps every bounded feature out of import cycles between features', () => {
        const graph = featureGraph();
        for (const feature of BOUNDED) expect(graph.has(feature), feature).toBe(true);
        const cycles = BOUNDED.flatMap((feature) => [...(graph.get(feature) ?? [])]
            .filter((other) => reaches(graph, other, feature))
            .map((other) => `${feature} -> ${other} -> ... -> ${feature}`));
        expect(cycles).toEqual([]);
    });
});
