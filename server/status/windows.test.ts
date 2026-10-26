import { describe, expect, it } from 'vitest';
import { CMD_LINE_LIMIT, encodedPowerShellCommand } from '../ops/remote';
import { WINDOWS_FALLBACK_FACTS, WINDOWS_STATUS_SCRIPT, WINDOWS_SYSTEM_FACTS, parseWindowsStatus } from './windows';

// What `ConvertTo-Json -Compress` prints for the status script.
const REPORT = {
    host: 'WIN-SRV01',
    os: 'Microsoft Windows Server 2022 Standard',
    ver: '10.0.20348',
    up: 345678.9,
    cores: 4,
    mem: { t: 8388148, f: 3145728, st: 1966080, sf: 1900000 },
    cpu: { i: 7500000, s: 10000000 },
    el: 10000000,
    disks: [
        { n: 'C:', fs: 'NTFS', s: 136256155648, f: 68128077824 },
        { n: 'D:', fs: 'ReFS', s: 536870912000, f: 429496729600 },
    ],
    net: [{ n: 'Intel[R] 82574L Gigabit Network Connection', rx: 2500000, tx: 1250000 }],
    procs: [
        { pid: 988, name: 'svchost', d: 1000000, ws: 52428800 },
        { pid: 4321, name: 'sqlservr', d: 15000000, ws: 2147483648 },
    ],
    users: 1,
};

describe('WINDOWS_STATUS_SCRIPT', () => {
    it('fits on a cmd.exe command line in the encoded fallback, and samples CPU per process', () => {
        const command = encodedPowerShellCommand(WINDOWS_STATUS_SCRIPT);
        expect(command.length).toBeLessThan(CMD_LINE_LIMIT);
        expect(command).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
        // Not the cumulative CPU seconds of Get-Process (Known issue backend/windows-status-shell-and-cpu fixed).
        expect(WINDOWS_STATUS_SCRIPT).toContain('TotalProcessorTime.Ticks');
        expect(WINDOWS_STATUS_SCRIPT).not.toContain('Sort-Object CPU');
    });

    it('leaves its own PowerShell out of the top processes, as the Linux script does', () => {
        expect(WINDOWS_STATUS_SCRIPT).toContain('Get-Process|%{if($_.Id -ne $PID){$p1[$_.Id]=');
        expect(WINDOWS_STATUS_SCRIPT).toContain('$_.Id -gt 0 -and $_.Id -ne $PID -and');
    });
});

describe('parseWindowsStatus', () => {
    it('reads one JSON report into a snapshot', () => {
        const snapshot = parseWindowsStatus(JSON.stringify(REPORT), 7);
        expect(snapshot).toMatchObject({
            platform: 'windows',
            collectedAt: 7,
            hostname: 'WIN-SRV01',
            os: 'Microsoft Windows Server 2022 Standard',
            kernel: '10.0.20348',
            uptimeSeconds: 345678,
            cpu: { usagePercent: 25, cores: 4, iowaitPercent: null },
            memory: { totalMB: 8191.6, usedMB: 5119.6, availableMB: 3072, usagePercent: 62.5 },
            swap: { totalMB: 1920, usedMB: 64.5, usagePercent: 3.4 },
            load: null,
            failedUnits: null,
            loggedInUsers: 1,
            sampleSeconds: 1,
            unavailable: [],
        });
        expect(snapshot.disks).toEqual([
            { name: 'C:', mount: 'C:', fsType: 'NTFS', totalGB: 126.9, usedGB: 63.4, freeGB: 63.4, usagePercent: 50 },
            { name: 'D:', mount: 'D:', fsType: 'ReFS', totalGB: 500, usedGB: 100, freeGB: 400, usagePercent: 20 },
        ]);
        expect(snapshot.network).toMatchObject({ rxBytesPerSec: 2500000, txBytesPerSec: 1250000 });
    });

    it('reports per-process CPU over the sample as % of one core (Known issue frontend/status-windows-cpu-seconds fixed)', () => {
        const { processes } = parseWindowsStatus(JSON.stringify(REPORT));
        expect(processes).toEqual([
            { pid: 4321, name: 'sqlservr', cpuPercent: 150, memoryMB: 2048, memoryPercent: 25 },
            { pid: 988, name: 'svchost', cpuPercent: 10, memoryMB: 50, memoryPercent: 0.6 },
        ]);
    });

    it('accepts single items that PowerShell did not wrap in arrays and ignores text around the JSON', () => {
        const single = { ...REPORT, disks: REPORT.disks[0], procs: REPORT.procs[0], net: REPORT.net[0] };
        const snapshot = parseWindowsStatus(`\r\nWARNING: something\r\n${JSON.stringify(single)}\r\n`);
        expect(snapshot.disks).toHaveLength(1);
        expect(snapshot.processes).toHaveLength(1);
        expect(snapshot.network?.interfaces).toHaveLength(1);
    });

    it('degrades section by section instead of failing the whole report', () => {
        const snapshot = parseWindowsStatus(JSON.stringify({ host: 'W', cores: 2, el: 10000000, mem: null, cpu: {}, disks: [], procs: [], users: null }));
        expect(snapshot.cpu).toBeNull();
        expect(snapshot.memory).toBeNull();
        expect(snapshot.unavailable).toEqual(['cpu', 'memory', 'swap', 'disks', 'processes', 'network', 'users']);
    });

    it('reads what a user who may not use WMI reports, and says it is limited', () => {
        // Captured over SSH with a standard user (Windows Server 2025).
        const report = {
            net: [{ rx: 21234, tx: 110, n: 'VNet' }], cpu: null, users: null, ver: '10.0.26100', procs: [], mem: { f: 2245304, t: 16776664 },
            el: 10535294, up: 628826.978381, wmi: false, host: 'WIN-SRV01', disks: [{ s: 171691732992, f: 66513371136, fs: 'NTFS', n: 'C:' }],
            cores: 6, os: 'Microsoft Windows Server 2025 Standard',
        };
        const snapshot = parseWindowsStatus(JSON.stringify(report));
        expect(snapshot).toMatchObject({
            limited: true,
            os: 'Microsoft Windows Server 2025 Standard',
            uptimeSeconds: 628826,
            cpu: null,
            memory: { totalMB: 16383.5, availableMB: 2192.7 },
            swap: null,
            disks: [{ name: 'C:', fsType: 'NTFS', totalGB: 159.9 }],
            network: { interfaces: [{ name: 'VNet' }] },
            unavailable: ['cpu', 'swap', 'processes', 'users'],
        });
        expect(parseWindowsStatus(JSON.stringify(REPORT))).not.toHaveProperty('limited');
    });

    it('uses WMI only as an administrator, and reads the rest without it', () => {
        expect(WINDOWS_STATUS_SCRIPT).toContain('$wmi=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)');
        expect(WINDOWS_SYSTEM_FACTS).toContain('}else{');
        expect(WINDOWS_FALLBACK_FACTS).not.toMatch(/Get-CimInstance|Get-WmiObject|Get-Counter/);
        for (const piece of ["Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'", '[Diagnostics.Stopwatch]::GetTimestamp()/[Diagnostics.Stopwatch]::Frequency', 'Microsoft.VisualBasic.Devices.ComputerInfo', '[IO.DriveInfo]::GetDrives()']) {
            expect(WINDOWS_FALLBACK_FACTS).toContain(piece);
        }
        expect(WINDOWS_STATUS_SCRIPT).toContain('[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()');
        // Without WMI no process list: reading another account's processor time is refused, slowly.
        expect(WINDOWS_STATUS_SCRIPT).toContain('$p1=@{};if($wmi){Get-Process|');
        // An uptime in UTC: no hour off after a daylight saving change.
        expect(WINDOWS_SYSTEM_FACTS).toContain('$up=([DateTime]::UtcNow-$o.LastBootUpTime.ToUniversalTime()).TotalSeconds');
    });

    it('fails with a clear message on output without a report, not "Unexpected end of JSON input"', () => {
        expect(() => parseWindowsStatus('')).toThrow(/no data/);
        expect(() => parseWindowsStatus('powershell : The term is not recognized')).toThrow(/no data/);
    });
});
