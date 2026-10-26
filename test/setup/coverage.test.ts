import { describe, expect, it } from 'vitest';

describe('coverage settings', () => {
    it('measure the desktop shell and the build scripts too, against floors CI enforces', async () => {
        const { default: config } = await import('../../vitest.config');
        const resolved = await config({ command: 'serve', mode: 'test' });
        const coverage = resolved.test?.coverage as { include?: string[]; thresholds?: Record<string, number> } | undefined;
        expect(coverage?.include).toEqual(expect.arrayContaining(['server/**', 'shared/**', 'src/**', 'electron/**', 'scripts/**']));
        expect(coverage?.thresholds).toMatchObject({
            lines: expect.any(Number),
            branches: expect.any(Number),
            functions: expect.any(Number),
            statements: expect.any(Number),
        });
    });
});
