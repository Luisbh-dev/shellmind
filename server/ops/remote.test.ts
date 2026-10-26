import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    cleanStderr,
    clixmlErrorText,
    commandFailure,
    compactPowerShell,
    createClixmlFilter,
    extractJson,
    encodedPowerShellCommand,
    parseSections,
    POWERSHELL_STDIN_COMMAND,
    powershellInvocation,
    powershellStdin,
    powershellStream,
    psQuote,
    shellQuote,
    windowsArgument,
} from './remote';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/ops/${name}`, import.meta.url)), 'utf8');

const result = (stdout: string, stderr: string, code: number | null = 1) => ({ stdout, stderr, code, signal: null });

describe('quoting', () => {
    it('single-quotes POSIX arguments', () => {
        expect(shellQuote('nginx.service')).toBe("'nginx.service'");
        expect(shellQuote("it's; rm -rf /")).toBe("'it'\\''s; rm -rf /'");
        expect(shellQuote('$(id) `id` $HOME')).toBe("'$(id) `id` $HOME'");
    });

    it('single-quotes PowerShell arguments', () => {
        expect(psQuote("O'Brien $env:PATH")).toBe("'O''Brien $env:PATH'");
        expect(psQuote('')).toBe("''");
    });

    it('spells what is not printable ASCII as [char] codes, outside the quotes', () => {
        expect(psQuote('C:\\Users\\Jos\u00e9\\app.log')).toBe("('C:\\Users\\Jos'+[char]0x00e9+'\\app.log')");
        // PowerShell ends a single-quoted string at the typographic quotes too.
        expect(psQuote('a\u2018b\u2019c\u201ad\u201be')).toBe("('a'+[char]0x2018+'b'+[char]0x2019+'c'+[char]0x201a+'d'+[char]0x201b+'e')");
        // A string comes first, so + concatenates; surrogates and line breaks go as codes.
        expect(psQuote("\u00f1\ud83d\ude00\n'x")).toBe("(''+[char]0x00f1+[char]0xd83d+[char]0xde00+[char]0x000a+'''x')");
        const part = "(?:'(?:[ -&(-~]|'')*'|\\[char\\]0x[0-9a-f]{4})";
        for (const value of ['\u2019;Write-Output x;\u2019', "line\n\n'; x", '\t\u0000\u007f']) {
            expect(psQuote(value)).toMatch(new RegExp(`^\\(${part}(?:\\+${part})*\\)$`));
        }
    });
});

describe('PowerShell delivery', () => {
    const PRELUDE = 'try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false}catch{}';

    it('writes the compacted script to the stdin of a fixed command, as one block an empty line closes', () => {
        expect(POWERSHELL_STDIN_COMMAND).toBe('powershell -NoProfile -NonInteractive -Command -');
        const stdin = powershellStdin('  # comment\n\n  if ($a) {\n    Get-Date\n  }\n');
        expect(stdin).toBe(`& {\n${PRELUDE}\nif ($a) {\nGet-Date\n}\nif(-not $?){exit 1}\n}\n\n`);
        // No other empty line: it would end the block early.
        expect(stdin.slice(0, -2)).not.toContain('\n\n');
        expect(powershellInvocation('Get-Date', 'stdin')).toEqual({ command: POWERSHELL_STDIN_COMMAND, stdin: powershellStdin('Get-Date') });
    });

    it('falls back to -EncodedCommand when asked to, and for a script that is not ASCII', () => {
        expect(powershellInvocation('Get-Date', 'encoded')).toEqual({ command: encodedPowerShellCommand('Get-Date'), stdin: '' });
        expect(powershellInvocation("'Jos\u00e9'", 'stdin')).toEqual({ command: encodedPowerShellCommand("'Jos\u00e9'"), stdin: '' });
        expect(powershellInvocation(`$p=${psQuote('C:\\Jos\u00e9')}`, 'stdin').command).toBe(POWERSHELL_STDIN_COMMAND);
    });

    it('keeps the stdin of a stream open after its script', () => {
        expect(powershellStream('Get-Date', 'stdin')).toEqual({ command: POWERSHELL_STDIN_COMMAND, input: powershellStdin('Get-Date') });
        expect(powershellStream('Get-Date', 'encoded')).toEqual({ command: encodedPowerShellCommand('Get-Date') });
    });

    it('encodes the fallback as UTF-16LE base64 behind the same UTF-8 output prelude', () => {
        const command = encodedPowerShellCommand('  # comment\n\n  Get-Date  \n');
        const encoded = command.split(' ').pop()!;
        const script = Buffer.from(encoded, 'base64').toString('utf16le');
        expect(command.startsWith('powershell -NoProfile -NonInteractive -EncodedCommand ')).toBe(true);
        expect(script.split('\n')).toEqual([PRELUDE, 'Get-Date']);
    });

    it('drops indentation, blank lines and comment lines', () => {
        expect(compactPowerShell('\n  $a=1\r\n\t# note\n  $a\n')).toBe('$a=1\n$a');
    });
});

describe('parseSections', () => {
    it('splits marked output and ignores anything before the first marker', () => {
        const sections = parseSections('motd noise\n\n@@SM:one\nfirst\n  line two  \n\n@@SM:two\r\n\r\n@@SM:three\nx');
        expect([...sections.entries()]).toEqual([['one', 'first\n  line two'], ['two', ''], ['three', 'x']]);
    });
});

describe('commandFailure', () => {
    it('maps permission problems to 403 and other failures to 502 with the remote message', () => {
        const denied = commandFailure(result('', 'Failed to restart nginx.service: Interactive authentication required.\n'), 'x');
        expect(denied).toMatchObject({ code: 'OPS_PERMISSION_DENIED', status: 403, message: 'Failed to restart nginx.service: Interactive authentication required.' });
        const failed = commandFailure(result('Error: No such container: web\n', '', 1), 'fallback');
        expect(failed).toMatchObject({ code: 'OPS_COMMAND_FAILED', status: 502, message: 'Error: No such container: web', details: { exitCode: 1 } });
        expect(commandFailure(result('', '', null), 'fallback').message).toBe('fallback');
    });

    it('reads PowerShell CLIXML errors', () => {
        const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Cannot find any service with service name \'x\'._x000D__x000A_</S></Objs>';
        expect(cleanStderr(clixml)).toBe("Cannot find any service with service name 'x'.");
    });

    it('keeps text a script wrote to stderr itself next to CLIXML progress (captured on Windows Server 2025)', () => {
        // A failed service action: the message, then the host's progress records.
        const stderr = fixture('powershell-stderr-action.txt');
        expect(cleanStderr(stderr)).toBe("Cannot find any service with service name 'ShellMindNoSuchSvc'.");
        expect(commandFailure(result('', stderr, 1), 'fallback').message).toBe("Cannot find any service with service name 'ShellMindNoSuchSvc'.");
    });
});

describe('createClixmlFilter', () => {
    const run = (chunks: string[]) => {
        let text = '';
        const filter = createClixmlFilter((part) => { text += part; });
        for (const chunk of chunks) filter.write(chunk);
        filter.end();
        return text;
    };

    it('turns the error records of a failed Get-Content into text and drops the rest (captured)', () => {
        const stderr = fixture('powershell-stderr-stream.txt');
        const text = run([stderr]);
        expect(text).toContain("Get-Content : Cannot find path 'C:\\logs\\missing.log' because it does not exist.\n");
        expect(text).toContain('FullyQualifiedErrorId : PathNotFound');
        expect(text).not.toMatch(/CLIXML|<Objs|Preparing modules/);
    });

    it('waits for whole lines, so records split across chunks still decode', () => {
        const stderr = fixture('powershell-stderr-action.txt');
        const pieces = stderr.match(/[\s\S]{1,37}/g) ?? [];
        expect(run(pieces)).toBe("Cannot find any service with service name 'ShellMindNoSuchSvc'.\n");
    });

    it('passes plain stderr through unchanged (a native program writing there)', () => {
        expect(run(['#< CLIXML\r\n', 'Error response from daemon: No such container: web\n', 'warn 1\nwarn', ' 2\n'])).toBe('Error response from daemon: No such container: web\nwarn 1\nwarn 2\n');
        // A last line without its newline is kept at the end.
        expect(run(['tail without newline'])).toBe('tail without newline\n');
    });

    it('decodes XML entities and the serializer escapes in messages', () => {
        const record = '<Objs Version="1.1.0.1"><S S="Error">Path &lt;C:\\a &amp; b&gt; isn&apos;t valid_x000D__x000A_</S></Objs>\n';
        expect(clixmlErrorText(record)).toBe("Path <C:\\a & b> isn't valid\r\n");
        expect(run(['#< CLIXML\n', record])).toBe("Path <C:\\a & b> isn't valid\n");
    });
});

describe('windowsArgument', () => {
    it('quotes Windows command-line arguments only when needed', () => {
        expect(windowsArgument('web-proxy-1')).toBe('web-proxy-1');
        expect(windowsArgument('--tail')).toBe('--tail');
        expect(windowsArgument('a b')).toBe('"a b"');
        expect(windowsArgument('')).toBe('""');
        expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
        expect(windowsArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
    });
});

describe('extractJson', () => {
    it('finds the JSON document in noisy output', () => {
        expect(extractJson('banner\n{"a":[1,2]}\n')).toEqual({ a: [1, 2] });
        expect(extractJson('[{"Name":"web"}]')).toEqual([{ Name: 'web' }]);
        expect(extractJson('no json here')).toBeNull();
        expect(extractJson('{broken')).toBeNull();
    });
});
