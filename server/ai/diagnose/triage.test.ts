import { describe, expect, it } from 'vitest';
import { CMD_LINE_LIMIT, encodedPowerShellCommand, psQuote } from '../../ops/remote';
import { testCaps } from '../../../test/helpers/opsCaps';
import { sections } from '../../../test/helpers/opsHost';
import { WINDOWS_LIMITED_STOPPED_SERVICES_SCRIPT, WINDOWS_STOPPED_SERVICES_SCRIPT } from './status';
import { windowsServiceEventsScript } from './service';
import { windowsTailScript } from './logs';
import { WINDOWS_LIMITED_TRIAGE_SCRIPT, WINDOWS_TRIAGE_SCRIPT, linuxTriageScript, parseTriage } from './triage';

describe('triage pack', () => {
    it('reads privileged sources through sudo -n only when the user may use it without a password', () => {
        const withSudo = linuxTriageScript(testCaps({ root: false, sudo: true }));
        expect(withSudo).toContain('sudo -n journalctl -p err -S -1h --no-pager -o short-iso -n 300');
        expect(withSudo).toContain('sudo -n dmesg');
        expect(withSudo).toContain('sudo -n ss -tulpn');
        const asRoot = linuxTriageScript(testCaps({ root: true }));
        expect(asRoot).not.toContain('sudo');
        expect(asRoot).toContain('journalctl -p err -S -1h');
        // Read-only: nothing that changes the system.
        expect(asRoot).not.toMatch(/\b(rm|kill|restart|start|stop|tee|chmod|chown|mv)\b/);
    });

    it('fits every Windows script on a cmd.exe command line in the encoded fallback', () => {
        const longest = {
            name: 'S'.repeat(256),
            display: 'D'.repeat(256),
            path: `C:\\${'p'.repeat(1020)}`
        };
        for (const script of [WINDOWS_TRIAGE_SCRIPT, WINDOWS_LIMITED_TRIAGE_SCRIPT, WINDOWS_STOPPED_SERVICES_SCRIPT, WINDOWS_LIMITED_STOPPED_SERVICES_SCRIPT, windowsServiceEventsScript(longest.name, longest.display), windowsTailScript(longest.path, 200)]) {
            expect(encodedPowerShellCommand(script).length).toBeLessThan(CMD_LINE_LIMIT);
        }
    });

    it('quotes the names a Windows script embeds as data, in ASCII', () => {
        const evil = 'Fake Service\u2019;Write-Output INJECTED;$x=\u2019';
        const script = windowsServiceEventsScript("svc'x", evil);
        expect(script).toContain("$n='svc''x';$d=('Fake Service'+[char]0x2019+';Write-Output INJECTED;$x='+[char]0x2019)\n");
        // A display name from the server stays on one line.
        expect(windowsServiceEventsScript('svc', "Evil\n#\n';Remove-Item C:\\ -Recurse;'")).toContain(`$d=${psQuote("Evil # ';Remove-Item C:\\ -Recurse;'")}\n`);
        expect(windowsServiceEventsScript('svc', '\n')).toContain("$n='svc';$d='svc'\n");
        const tail = windowsTailScript('C:\\it\u2019s\\app.log', 200);
        expect(tail).toContain("-LiteralPath ('C:\\it'+[char]0x2019+'s\\app.log') -Tail 200");
        // Nothing to decode at run time (server/ai/diagnose/powershell.test.ts reads them back with PowerShell).
        // eslint-disable-next-line no-control-regex -- ASCII is \x00-\x7f
        for (const text of [script, tail]) expect(text).not.toMatch(/[^\x00-\x7f]|FromBase64String/);
    });

    it('turns the script output into titled sections, folding repeated errors and flagging what is missing', () => {
        const output = sections({
            system: 'Host: web-01\nUbuntu 22.04.4 LTS',
            failed: 'nginx.service loaded failed failed A high performance web server',
            errors: Array.from({ length: 30 }, (_, i) => `2024-05-06T10:${String(i).padStart(2, '0')}:00+0000 web-01 kernel: EXT4-fs error (device sda1): inode ${100 + i}`).join('\n'),
            kernel: '',
            disk: 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 50G 47G 3G 94% /',
            memory: 'Mem: 3900 3700 200',
            processes: 'PID USER %CPU COMMAND\n42 app 99.0 java'
        }).replace('\n@@SM:end\n', '\n');

        const parsed = parseTriage('linux', output);
        expect(parsed.map((section) => section.id)).toEqual(['system', 'failed-units', 'errors', 'kernel', 'disk', 'memory', 'processes', 'ports']);
        expect(parsed.find((section) => section.id === 'errors')?.text).toContain('[... 28 similar lines]\n2024-05-06T10:29:00+0000 web-01 kernel: EXT4-fs error (device sda1): inode 129');
        expect(parsed.find((section) => section.id === 'kernel')?.text).toBe('(nothing found)');
        expect(parsed.find((section) => section.id === 'ports')).toMatchObject({ failed: true, text: '(not reported: the script stopped before this part)' });
        expect(parsed.find((section) => section.id === 'disk')?.source).toBe('df -hP; df -iP');
    });

    it('falls back to syslog when the journal cannot be read, and says which parts the user may not read', () => {
        const script = linuxTriageScript(testCaps({ root: false, sudo: false }));
        expect(script).toContain("*'insufficient permissions'*|*'not seeing messages from other users'*) r=denied;;");
        expect(script).toContain('for l in /var/log/syslog /var/log/messages');
        expect(script).toContain('else echo "!unreadable: ${r:-none}"; fi');
        expect(script).toContain('if k=$(dmesg 2>&1); then');

        const output = sections({
            system: 'Host: web-01',
            failed: '(none)',
            errors: '!unreadable: denied',
            kernel: '!unreadable: dmesg dmesg: read kernel buffer failed: Operation not permitted',
            disk: '/dev/sda1 50G 47G 3G 94% /',
            memory: 'Mem: 3900 3700 200',
            processes: 'PID USER %CPU COMMAND',
            ports: 'tcp LISTEN 0.0.0.0:22'
        });
        const parsed = parseTriage('linux', output);
        expect(parsed.find((section) => section.id === 'errors')).toMatchObject({
            failed: true,
            text: expect.stringContaining('may not read the system journal: that needs root, passwordless sudo, or membership in the systemd-journal (or adm) group. No readable /var/log/syslog')
        });
        expect(parsed.find((section) => section.id === 'kernel')).toMatchObject({
            failed: true,
            text: expect.stringContaining('The kernel log (dmesg) cannot be read: it needs root or passwordless sudo (kernel.dmesg_restrict), and inside a container the CAP_SYSLOG capability (dmesg: read kernel buffer failed: Operation not permitted).')
        });
        expect(parseTriage('linux', sections({ errors: '!unreadable: none' })).find((section) => section.id === 'errors')?.text).toContain('This server has no journal, and no readable /var/log/syslog or /var/log/messages.');
        expect(parsed.filter((section) => section.failed).map((section) => section.id)).toEqual(['errors', 'kernel']);
    });

    it('reads the Windows sections', () => {
        const output = '@@SM:system\nHost: DC01\n@@SM:errors\n3x System/Disk id 7, 10:00:00-10:30:00 UTC: The device has a bad block.\n@@SM:stopped\nSpooler (Print Spooler): Stopped, exit code 1067\n@@SM:disk\nC: 2.0 GB free of 100.0 GB (98% used)\n@@SM:memory\nMemory: 100 MB available of 8,192 MB\n@@SM:processes\nsqlservr (pid 1234): 9,999 s of CPU time, 4,000 MB\n@@SM:ports\ntcp 0.0.0.0:1433 pid 1234 sqlservr\n@@SM:end\n';
        const parsed = parseTriage('windows', output);
        expect(parsed.map((section) => section.id)).toEqual(['system', 'errors', 'stopped-services', 'disk', 'memory', 'processes', 'ports']);
        expect(parsed.every((section) => !section.failed)).toBe(true);
        expect(parsed[2].text).toBe('Spooler (Print Spooler): Stopped, exit code 1067');
    });

    it('reads the Windows sections of a user who is not an administrator, naming what it may not read', () => {
        // Captured over SSH with a standard user (Windows Server 2025), shortened.
        const output = '@@SM:system\nHost: WIN-SRV01\nMicrosoft Windows Server 2025 Standard 10.0.26100\nLast boot: 2026-10-18T21:25:22Z, up 175 h\n@@SM:errors\n!unreadable: eventlog\n@@SM:stopped\n!unreadable: services\n@@SM:disk\nC: 61.3 GB free of 159.9 GB (62% used)\n@@SM:memory\nMemory: 3,137 MB available of 16,383 MB\n@@SM:processes\n(By memory: the processor time of other accounts is not readable.)\nvmmemWSL (pid 13936): 4,953 MB\n@@SM:ports\ntcp 0.0.0.0:22 pid 9372 sshd\n@@SM:end\n';
        const parsed = parseTriage('windows', output, true);
        expect(parsed.filter((section) => section.failed).map((section) => [section.id, section.text])).toEqual([
            ['errors', 'Could not be read (OPS_PERMISSION_DENIED): The login user may not read the System and Application event logs: over SSH that needs an administrator or a member of Event Log Readers.'],
            ['stopped-services', 'Could not be read (OPS_PERMISSION_DENIED): The login user may not list the services: over SSH Windows lets only administrators do that.'],
        ]);
        expect(Object.fromEntries(parsed.map((section) => [section.id, section.source]))).toMatchObject({ processes: 'Get-Process | Sort-Object WorkingSet64 -Descending', ports: 'netstat -ano', disk: 'DriveInfo' });
        // Neither WMI nor a processor time it may not read: each refusal takes seconds.
        expect(WINDOWS_LIMITED_TRIAGE_SCRIPT).not.toMatch(/Get-CimInstance|Get-NetTCPConnection|Sort-Object CPU/);
        expect(WINDOWS_LIMITED_TRIAGE_SCRIPT).toContain("catch [UnauthorizedAccessException]{$false}");
    });
});
