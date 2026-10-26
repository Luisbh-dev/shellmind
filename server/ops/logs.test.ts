import { describe, expect, it } from 'vitest';
import { testCaps } from '../../test/helpers/opsCaps';
import type { LogSource, OpsCapabilities } from '../../shared/ops';
import { unwrapPowerShellStdin } from '../../test/helpers/opsHost';
import { logStreamCommand, parseLogSource, windowsEngineLogScript, windowsFileLogScript, withWatchdog } from './logs';
import { CMD_LINE_LIMIT, encodedPowerShellCommand, POWERSHELL_STDIN_COMMAND } from './remote';

// The command the login shell receives is `sh -c '<script>'`; this undoes
// that quoting to look at the script sh runs.
function innerScript(command: string): string {
    const match = /^sh -c '([\s\S]*)'$/.exec(command);
    if (!match) throw new Error(`not an sh -c command: ${command}`);
    return match[1].replace(/'\\''/g, "'");
}

// A Linux stream reads nothing on stdin.
function command(caps: OpsCapabilities, source: LogSource): string {
    const stream = logStreamCommand(caps, source);
    expect(stream.input).toBeUndefined();
    return stream.command;
}

describe('logStreamCommand on Linux', () => {
    it('follows the journal, optionally of one unit, behind the stdin watchdog', () => {
        expect(innerScript(command(testCaps(), { kind: 'journal' })))
            .toBe('exec 3<&0; journalctl -f -n 200 --no-pager -o short-iso </dev/null 2>&1 & p=$!; { read -r _ <&3; kill $p 2>/dev/null; } & w=$!; wait $p; r=$?; kill $w 2>/dev/null; exit $r');
        expect(innerScript(command(testCaps({ root: false, sudo: true }), { kind: 'journal', unit: 'nginx.service' })))
            .toContain("sudo -n journalctl -f -n 200 --no-pager -o short-iso -u 'nginx.service' </dev/null");
        expect(() => logStreamCommand(testCaps({ journal: false }), { kind: 'journal' })).toThrow(/no systemd journal/);
    });

    it('tails absolute paths and paths in the home directory only', () => {
        expect(innerScript(command(testCaps(), { kind: 'file', path: '/var/log/nginx/access.log' })))
            .toContain("tail -n 200 -F -- '/var/log/nginx/access.log' </dev/null");
        expect(innerScript(command(testCaps({ root: false, sudo: true }), { kind: 'file', path: '~/logs/app (1).log' })))
            .toContain(`sudo -n tail -n 200 -F -- "$HOME"/'logs/app (1).log' </dev/null`);
        for (const path of ['var/log/syslog', "/var/log/x'; reboot", '/var/log/$(id)', '/var/../etc/shadow', '/tmp/a\nb', '',
            '~', '~root/.bash_history', '~/../root/x', '~/$(id)', 'logs/~/app.log']) {
            expect(() => logStreamCommand(testCaps(), { kind: 'file', path }), path).toThrow(/absolute file path/);
        }
    });

    it('follows container logs with the detected engine', () => {
        expect(innerScript(command(testCaps({ containers: { sudo: true } }), { kind: 'container', container: 'web-proxy-1' })))
            .toContain("sudo -n docker 'logs' '-f' '--tail' '200' '--timestamps' 'web-proxy-1' </dev/null");
        expect(() => logStreamCommand(testCaps(), { kind: 'container', container: 'web;id' })).toThrow(/not a valid container/);
    });

    it('nests quotes so the outer shell passes the script through unchanged', () => {
        const command = withWatchdog("tail -F -- '/var/log/it'\\''s.log'");
        expect(command.startsWith("sh -c '")).toBe(true);
        expect(innerScript(command)).toContain("tail -F -- '/var/log/it'\\''s.log'");
    });
});

describe('logStreamCommand on Windows', () => {
    const windows = testCaps({ platform: 'windows', root: null, systemd: false, journal: false });
    // The script, written to stdin (which stays open); its encoded fallback
    // must fit a cmd.exe command line too.
    const streamScript = (source: LogSource) => {
        const stream = logStreamCommand(windows, source);
        expect(stream.command).toBe(POWERSHELL_STDIN_COMMAND);
        const script = unwrapPowerShellStdin(stream.input ?? '');
        expect(script).not.toBeNull();
        expect(encodedPowerShellCommand(script!).length).toBeLessThan(CMD_LINE_LIMIT);
        return script!;
    };

    it('follows a file with Get-Content -Wait in a runspace it stops once stdin closes', () => {
        const script = streamScript({ kind: 'file', path: 'C:\\Program Files\\App\\app (1).log' });
        expect(script).toContain("Get-Content -LiteralPath 'C:\\Program Files\\App\\app (1).log' -Wait -Tail 200 -ErrorAction Stop");
        expect(streamScript({ kind: 'file', path: 'C:\\Usuarios\\Jos\u00e9\\app.log' })).toContain("Get-Content -LiteralPath ('C:\\Usuarios\\Jos'+[char]0x00e9+'\\app.log') -Wait");
        expect(() => logStreamCommand(windows, { kind: 'file', path: "C:\\logs\\it's.log" })).toThrow(/absolute file path/);
        // Errors are printed on stdout (PowerShell's own stderr is CLIXML in the fallback).
        expect(script).toContain('catch{$o.WriteLine($_.Exception.Message);$r.c=1}');
        expect(script).toContain('[Console]::OpenStandardInput()');
        expect(script).toContain('if(-not $h.IsCompleted){$w.Stop();exit 0}');
        expect(script).not.toContain('[Environment]::Exit');
    });

    it('starts the engine as a child process and kills it once stdin closes', () => {
        const script = streamScript({ kind: 'container', container: 'web-proxy-1' });
        expect(script).toContain("@(Get-Command 'docker' -CommandType Application -ErrorAction Stop)[0].Source,'logs -f --tail 200 --timestamps web-proxy-1'");
        expect(script).toContain('$s.RedirectStandardInput=$true');
        expect(script).toContain('if($e.IsCompleted){try{$p.Kill()}catch{};exit 0}');
        expect(script).toContain('exit $p.ExitCode');
        expect(() => logStreamCommand(windows, { kind: 'container', container: 'web" & calc' })).toThrow(/not a valid container/);
    });

    it('refuses relative paths and the journal', () => {
        expect(() => logStreamCommand(windows, { kind: 'file', path: '/var/log/syslog' })).toThrow(/absolute file path/);
        expect(() => logStreamCommand(windows, { kind: 'journal' })).toThrow(/no systemd journal/);
    });

    it('quotes engine arguments for the Windows command line, then for PowerShell', () => {
        expect(windowsEngineLogScript('docker', ['logs', "it's a b"])).toContain("'logs \"it''s a b\"'");
        expect(windowsFileLogScript('C:\\a.log')).toContain("-LiteralPath 'C:\\a.log'");
    });
});

describe('parseLogSource', () => {
    it('normalises what the client sent', () => {
        expect(parseLogSource({ kind: 'journal', unit: ' nginx ' })).toEqual({ kind: 'journal', unit: 'nginx.service' });
        expect(parseLogSource({ kind: 'journal', unit: '' })).toEqual({ kind: 'journal' });
        expect(parseLogSource({ kind: 'file', path: ' /var/log/syslog ' })).toEqual({ kind: 'file', path: '/var/log/syslog' });
        expect(parseLogSource({ kind: 'container', container: 7 })).toEqual({ kind: 'container', container: '' });
        // W7-S3: a Compose project, or one of its services (validated when the command is built).
        expect(parseLogSource({ kind: 'compose', project: ' shop ', service: '' })).toEqual({ kind: 'compose', project: 'shop' });
        expect(parseLogSource({ kind: 'compose', project: 'shop', service: 'web' })).toEqual({ kind: 'compose', project: 'shop', service: 'web' });
        expect(() => parseLogSource({ kind: 'command', command: 'id' })).toThrow(/Unknown log source/);
        expect(() => parseLogSource(null)).toThrow(/Unknown log source/);
    });
});
