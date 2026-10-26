import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testCaps } from '../../test/helpers/opsCaps';
import {
    journalCommand,
    parseSystemdDetail,
    parseSystemdServices,
    parseWindowsDetail,
    parseWindowsServices,
    prepareServiceAction,
    privileged,
    systemdDetailScript,
    WINDOWS_LIST_SERVICES_SCRIPT,
    windowsActionScript,
    windowsDetailScript,
} from './services';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/ops/${name}`, import.meta.url)), 'utf8');

describe('parseSystemdServices', () => {
    const services = parseSystemdServices(fixture('systemctl.txt'));

    it('merges loaded units with installed unit files', () => {
        expect(services.find((service) => service.name === 'nginx.service')).toEqual({
            name: 'nginx.service',
            description: 'A high performance web server and a reverse proxy server',
            load: 'loaded',
            active: 'failed',
            sub: 'failed',
            startup: 'enabled',
        });
        // Installed but never loaded: still listed, so it can be started.
        expect(services.find((service) => service.name === 'postgresql.service')).toEqual({
            name: 'postgresql.service', description: '', load: null, active: 'inactive', sub: 'dead', startup: 'disabled',
        });
        expect(services.find((service) => service.name === 'auditd.service')).toMatchObject({ load: 'not-found', active: 'inactive' });
    });

    it('lists template instances but not the templates themselves', () => {
        const names = services.map((service) => service.name);
        expect(names).toContain('getty@tty1.service');
        expect(names).toContain('systemd-fsck@dev-disk-by\\x2duuid-1234.service');
        expect(names).not.toContain('getty@.service');
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
});

describe('parseWindowsServices', () => {
    it('maps Get-Service rows', () => {
        const raw = JSON.stringify({
            limited: false,
            services: [
                { n: 'wuauserv', d: 'Windows Update', s: 'Stopped', t: 'Manual' },
                { n: 'Spooler', d: 'Print Spooler', s: 'Running', t: 'Automatic' },
            ],
        });
        expect(parseWindowsServices(raw)).toEqual({
            services: [
                { name: 'Spooler', description: 'Print Spooler', load: null, active: 'active', sub: 'Running', startup: 'Automatic' },
                { name: 'wuauserv', description: 'Windows Update', load: null, active: 'inactive', sub: 'Stopped', startup: 'Manual' },
            ],
        });
        // PowerShell leaves a one-element array unwrapped when it is not built with @().
        expect(parseWindowsServices(JSON.stringify({ services: { n: 'One', d: 'Only', s: 'StartPending', t: 'Manual' } })).services[0].active).toBe('activating');
    });

    it('says when the list is only what a user who may not list the services may query', () => {
        expect(parseWindowsServices(JSON.stringify({ limited: true, services: [{ n: 'BFE', d: 'Base Filtering Engine', s: 'Running', t: 'Automatic' }] })))
            .toMatchObject({ limited: true, services: [{ name: 'BFE', active: 'active' }] });
        // The service manager's list, or else each service the registry names.
        expect(WINDOWS_LIST_SERVICES_SCRIPT).toContain('$s=@(Get-Service -ErrorVariable e)');
        expect(WINDOWS_LIST_SERVICES_SCRIPT).toContain("if(-not $s.Count -and $e){$l=$true;$s=@(Get-Service -Name @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services'");
    });
});

describe('service detail', () => {
    it('quotes the unit in the detail script and parses systemctl show', () => {
        expect(systemdDetailScript('nginx.service')).toContain("-- 'nginx.service' 2>&1");
        const detail = parseSystemdDetail('nginx.service', '@@SM:show\nId=nginx.service\nActiveState=failed\nExecMainStartTimestamp=Mon 2024-05-06 10:00:00 UTC\n@@SM:status\n× nginx.service - web\n@@SM:end\n');
        expect(detail).toEqual({
            name: 'nginx.service',
            properties: { Id: 'nginx.service', ActiveState: 'failed', ExecMainStartTimestamp: 'Mon 2024-05-06 10:00:00 UTC' },
            statusText: '× nginx.service - web',
        });
        expect(parseWindowsDetail('Spooler', '{"Name":"Spooler","ProcessId":"1234","Description":null}').properties).toEqual({ Name: 'Spooler', ProcessId: '1234' });
    });

    it('lists the running dependents of a Windows service (captured on Windows Server 2025)', () => {
        const detail = parseWindowsDetail('LanmanWorkstation', fixture('windows-service-detail.json'));
        expect(detail.dependents).toEqual(['SessionEnv']);
        expect(detail.properties).toMatchObject({ Name: 'LanmanWorkstation', State: 'Running', StartMode: 'Auto' });
        expect(detail.properties).not.toHaveProperty('Dependents');
        // PowerShell leaves a one-element array unwrapped when it is not built with @().
        expect(parseWindowsDetail('x', '{"Name":"x","Dependents":"Netlogon"}').dependents).toEqual(['Netlogon']);
        expect(parseWindowsDetail('x', '{"Name":"x","Dependents":[]}').dependents).toEqual([]);
        expect(windowsDetailScript('LanmanWorkstation')).toContain("$g=Get-Service -Name 'LanmanWorkstation'\n$dep=@($g|%{$_.DependentServices}|?{$_.Status -eq 'Running'}|%{$_.Name})");
    });

    it('reads a Windows service without WMI for a user who is not an administrator', () => {
        const script = windowsDetailScript('Spooler');
        // WMI only for an administrator (a refused query takes seconds).
        expect(script).toContain("$s=$null;if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)){$s=Get-CimInstance Win32_Service -Filter 'Name=''Spooler'''}");
        expect(script).toContain("$k=Get-ItemProperty ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+'Spooler')");
        // In the registry but not visible to the user: denied, not missing.
        expect(script).toContain("if(-not $g){if($k){exit 5};[Console]::Error.WriteLine('Service not found');exit 4}");
        const detail = parseWindowsDetail('EventLog', '{"Description":null,"PathName":"C:\\\\WINDOWS\\\\System32\\\\svchost.exe -k LocalServiceNetworkRestricted -p","Dependents":[],"StartName":"NT AUTHORITY\\\\LocalService","State":"Running","Name":"EventLog","DelayedAutoStart":"False","StartMode":"Auto","DisplayName":"Windows Event Log"}');
        expect(detail).toMatchObject({ dependents: [], properties: { State: 'Running', StartMode: 'Auto', StartName: 'NT AUTHORITY\\LocalService' } });
    });
});

describe('prepareServiceAction', () => {
    it('builds systemctl commands from validated names', () => {
        expect(prepareServiceAction(testCaps(), 'nginx.service', 'restart')).toMatchObject({
            display: "systemctl --no-ask-password restart -- 'nginx.service'",
            meta: { kind: 'service', action: 'restart', target: 'nginx.service' },
        });
        expect(prepareServiceAction(testCaps({ root: false, sudo: true }), 'nginx.service', 'enable').display)
            .toBe("sudo -n systemctl --no-ask-password enable -- 'nginx.service'");
        // Without passwordless sudo, polkit decides (and the error says so).
        expect(privileged(testCaps({ root: false, sudo: false }))).toBe('');
    });

    it('refuses anything that is not a plain unit name or a known action', () => {
        for (const name of ['nginx.service; reboot', "x'.service", '$(id).service', '../x.service', 'nginx', '-x.service x']) {
            expect(() => prepareServiceAction(testCaps(), name, 'start'), name).toThrow(/not a valid service name/);
        }
        expect(() => prepareServiceAction(testCaps(), 'nginx.service', 'mask')).toThrow(/not a service action/);
        expect(() => prepareServiceAction(testCaps({ systemd: false }), 'nginx.service', 'start')).toThrow(/does not run systemd/);
    });

    it('uses the service cmdlets on Windows (start/stop/restart only)', () => {
        const caps = testCaps({ platform: 'windows', root: null });
        expect(prepareServiceAction(caps, 'Spooler', 'start').display).toBe("Start-Service -Name 'Spooler'");
        // -Force: a service with dependents cannot be stopped or restarted otherwise.
        expect(prepareServiceAction(caps, 'LanmanWorkstation', 'stop').display).toBe("Stop-Service -Force -Name 'LanmanWorkstation'");
        expect(prepareServiceAction(caps, 'Spooler', 'restart').display).toBe("Restart-Service -Force -Name 'Spooler'");
        expect(() => prepareServiceAction(caps, 'Spooler', 'enable')).toThrow(/not a service action/);
        expect(() => prepareServiceAction(caps, "Spool'er", 'start')).toThrow(/not a valid service name/);
    });

    it('reports a Windows action refused for lack of rights as such', () => {
        // The innermost cause joins the message ("... Cannot open Spooler service on computer '.'. Access is denied"),
        // and a service the user may not even see is not reported missing.
        const body = windowsActionScript('Spooler', "Start-Service -Name 'Spooler'");
        expect(body).toContain("try{Start-Service -Name 'Spooler';exit 0}catch{");
        expect(body).toContain('$i=$_.Exception;while($i.InnerException){$i=$i.InnerException};if(-not $m.Contains($i.Message)){$m+=\' \'+$i.Message}');
        expect(body).toContain("if(-not (Get-Service -Name 'Spooler' -EA 0) -and (Test-Path ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+'Spooler'))){$m='Access is denied: over SSH Windows lets only administrators query or manage most services.'}");
    });

    it('reads a unit journal with sudo when the user may', () => {
        expect(journalCommand(testCaps({ root: false, sudo: true }), 'ssh.service', 50)).toBe("sudo -n journalctl -u 'ssh.service' -n 50 --no-pager -o short-iso 2>&1");
    });
});
