import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { encodePowerShellBlock } from '../../shared/powershell';
import { PROCESS_TEST_TIMEOUT_MS } from '../setup/timeouts';

// The runner line typed into a real Windows PowerShell: the block's state
// persists for the next line, each statement prints with its own format, and
// a block that does not parse runs nothing.
describe.runIf(process.platform === 'win32')('the runner line in Windows PowerShell', () => {
    const run = (...lines: string[]) => {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
            input: `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${lines.join('\n')}\n`,
            encoding: 'utf8',
            timeout: PROCESS_TEST_TIMEOUT_MS,
            windowsHide: true
        });
        return `${result.stdout}\n${result.stderr}`;
    };

    it('keeps cd and variables, and formats each statement on its own', () => {
        const block = [
            "$greeting = 'hola ñandú'",
            'Set-Location $env:SystemRoot',
            "[pscustomobject]@{ Name = 'first'; Id = 1 }",
            'Get-Item . |',
            "  Select-Object @{ n = 'Folder'; e = { $_.Name } }, @{ n = 'Kind'; e = { 'dir' } }"
        ].join('\n');
        const output = run(encodePowerShellBlock(block), '"$greeting in $((Get-Location).Path)"');
        // Run as one pipeline, the second table would lose its columns.
        expect(output).toMatch(/Folder\s+Kind/);
        expect(output).toMatch(/Windows\s+dir/i);
        expect(output).toMatch(/hola ñandú in C:\\Windows/i);
    }, PROCESS_TEST_TIMEOUT_MS);

    it('keeps the traps of a block (it runs as one script)', () => {
        const output = run(encodePowerShellBlock('trap { "TRAPPED: $_"; continue }\n"before"\nthrow "boom"\n"after-throw"'), '"next line"');
        expect(output).toMatch(/before\s+TRAPPED: boom\s+after-throw\s+next line/);
    }, PROCESS_TEST_TIMEOUT_MS);

    it('runs nothing of a block that does not parse', () => {
        const output = run(encodePowerShellBlock('"must not print"\nGet-Process | Where-Object { $_.CPU -gt 1'));
        expect(output).not.toContain('must not print');
        expect(output).toMatch(/Missing closing '}'/);
    }, PROCESS_TEST_TIMEOUT_MS);
});
