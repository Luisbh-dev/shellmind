import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The rules that were warnings while the code base was being typed and made
// accessible are errors now: as warnings they let regressions through.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function lint(code: string, filePath: string) {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(code, { filePath });
    return result!.messages.map((message) => ({ rule: message.ruleId, severity: message.severity }));
}

describe('lint rules', () => {
    it('rejects `any`', async () => {
        expect(await lint('export const value: any = 1;\n', 'server/lint-probe.ts')).toContainEqual({ rule: '@typescript-eslint/no-explicit-any', severity: 2 });
    });

    it('rejects inaccessible markup in the UI', async () => {
        const code = 'export function Probe() {\n    return <img src="logo.png" />;\n}\n';
        expect(await lint(code, 'src/lint-probe.tsx')).toContainEqual({ rule: 'jsx-a11y/alt-text', severity: 2 });
    });
}, 60_000);
