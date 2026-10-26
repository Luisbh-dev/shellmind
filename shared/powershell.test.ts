import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePowerShellBlock, expandEncodedBlocks, showsRunnerEcho } from './powershell';

// The block a runner line carries, decoded the way PowerShell decodes it
// (DeflateStream over the base64).
function carriedBlock(line: string): string {
    const base64 = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(line)?.[1];
    if (base64 === undefined) throw new Error(`no encoded block in ${line}`);
    return inflateRawSync(Buffer.from(base64, 'base64')).toString('utf8');
}

const RUNNER_END = '} else { . $__sm } } finally { Remove-Variable __sm, __st -ErrorAction Ignore }';

describe('encodePowerShellBlock', () => {
    it('carries the block as compressed UTF-8 on one line', () => {
        const block = "Get-Process |\n  Sort-Object CPU -Descending\n\"ñandú ✓ 漢字 'quoted' `tick` $env:TEMP\"";
        const line = encodePowerShellBlock(block);
        expect(line).not.toMatch(/[\r\n]/);
        expect(carriedBlock(line)).toBe(block);
        // Nothing of the block itself is left for the shell to parse.
        expect(line).not.toContain('Sort-Object');
    });

    it('normalizes line breaks and drops trailing ones', () => {
        expect(carriedBlock(encodePowerShellBlock('a\r\nb\rc\n\n'))).toBe('a\nb\nc');
    });

    it('keeps long blocks short', () => {
        const block = Array.from({ length: 4000 }, (_, i) => `"line ${i} ñ"`).join('\n');
        const line = encodePowerShellBlock(block);
        expect(carriedBlock(line)).toBe(block);
        // PSReadLine redraws the line as it arrives: its length matters.
        expect(line.length).toBeLessThan(block.length / 2);
    });

    it('runs the block statement by statement in the current scope, unless it needs to run as one script', () => {
        const line = encodePowerShellBlock('x');
        expect(line.startsWith('try { $__sm = [scriptblock]::Create([IO.StreamReader]::new([IO.Compression.DeflateStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String(')).toBe(true);
        expect(line).toContain("')), [IO.Compression.CompressionMode]::Decompress)).ReadToEnd());");
        expect(line).toContain('foreach ($__st in $__sm.Ast.EndBlock.Statements) { . ([scriptblock]::Create($__st.Extent.Text)) | Out-Default }');
        // Traps live outside the statements: a block with one runs whole.
        expect(line).toContain('-not ($__sm.Ast.ParamBlock -or $__sm.Ast.UsingStatements -or $__sm.Ast.EndBlock.Traps)');
        expect(line.endsWith(RUNNER_END)).toBe(true);
    });
});

describe('expandEncodedBlocks', () => {
    const block = 'Get-Date\n"ñ ✓"';
    const line = encodePowerShellBlock(block);

    it('shows the block in place of its runner line, also when the terminal wrapped it', () => {
        expect(expandEncodedBlocks(`PS C:\\> ${line}\nresult\nPS C:\\>`)).toBe(`PS C:\\> ${block}\nresult\nPS C:\\>`);
        const wrapped = line.match(/.{1,37}/g)!.join('\n');
        expect(expandEncodedBlocks(`PS C:\\> ${wrapped}\nresult`)).toBe(`PS C:\\> ${block}\nresult`);
        const other = encodePowerShellBlock('Get-Service');
        expect(expandEncodedBlocks(`PS C:\\> ${line}\nresult\nPS C:\\> ${other}\nRunning sshd\nPS C:\\>`))
            .toBe(`PS C:\\> ${block}\nresult\nPS C:\\> Get-Service\nRunning sshd\nPS C:\\>`);
    });

    it('drops what earlier redraws of a long runner line left before its final echo', () => {
        // PSReadLine redraws the line as it arrives; redraws that scrolled
        // away stay on the rows the line ends on.
        const partial = `PS C:\\Users\\luis> ${line.slice(0, 180)}`;
        const remnants = `${line.slice(150, 190)}${partial}`;
        expect(expandEncodedBlocks(`earlier output\n${remnants}PS C:\\Users\\luis> ${line}\nresult\nPS C:\\Users\\luis>`))
            .toBe(`earlier output\nPS C:\\Users\\luis> ${block}\nresult\nPS C:\\Users\\luis>`);
        // ConPTY's repaints can break remnants off on lines of their own.
        const base64 = /FromBase64String\('([^']*)'/.exec(line)![1];
        const above = [`ate([IO.StreamReader]::new(${line.slice(60, 120)}`, base64.repeat(3), '} else { . $__sm } }'].join('\n');
        expect(expandEncodedBlocks(`PS C:\\> Get-Date\n12:00\n${above}\nPS C:\\> ${line}\nresult`))
            .toBe(`PS C:\\> Get-Date\n12:00\nPS C:\\> ${block}\nresult`);
        // Ordinary output above stays, base64 included.
        const token = 'eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0';
        expect(expandEncodedBlocks(`token: ${token}\nPS C:\\> ${line}\nresult`)).toBe(`token: ${token}\nPS C:\\> ${block}\nresult`);
    });

    it('drops an echo whose start was cut off, keeping what the block printed', () => {
        const cut = line.slice(line.indexOf("FromBase64String('") + 30);
        const output = `${cut}\nresult\nPS C:\\>`;
        expect(showsRunnerEcho(output)).toBe(true);
        expect(expandEncodedBlocks(output)).toBe('\nresult\nPS C:\\>');
        // The prompt of an earlier redraw stays.
        expect(expandEncodedBlocks(`${line.slice(200, 260)}PS C:\\> ${line.slice(0, 120)}${cut}\nresult`)).toBe('PS C:\\> \nresult');
    });

    it('leaves other output alone', () => {
        const text = "PS C:\\> [Convert]::FromBase64String('aGk=')\n104\n105";
        expect(expandEncodedBlocks(text)).toBe(text);
        expect(showsRunnerEcho(text)).toBe(false);
        expect(showsRunnerEcho(`PS C:\\> ${line.slice(0, -40)}`)).toBe(false);
        // A runner line whose block does not decode is shown as it is.
        const forged = `PS C:\\> ${line.replace(/FromBase64String\('[^']*'/, "FromBase64String('aGVsbG8='")}`;
        expect(expandEncodedBlocks(forged)).toBe(forged);
    });
});
