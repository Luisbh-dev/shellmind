import { describe, expect, it } from 'vitest';
import type { ServerSummary } from '../../shared/types';
import { classifyOs, promptShell, resolveChatEnvironment } from './environment';

const server = (overrides: Partial<ServerSummary>): ServerSummary => ({ id: 1, name: 'srv', ip: '10.0.0.1', type: 'linux', ...overrides });

describe('resolveChatEnvironment', () => {
    it('describes a Linux server as a remote POSIX shell', () => {
        expect(resolveChatEnvironment({ server: server({ os_detail: 'Ubuntu 22.04.4 LTS' }) })).toMatchObject({
            kind: 'posix', location: 'remote', osFamily: 'linux', serverName: 'srv'
        });
    });

    it('treats a Windows SSH server as cmd.exe unless the prompt shows PowerShell', () => {
        expect(resolveChatEnvironment({ server: server({ type: 'windows' }), terminalOutput: 'Microsoft Windows\r\nC:\\Users\\admin>' })).toMatchObject({ kind: 'cmd', osFamily: 'windows' });
        expect(resolveChatEnvironment({ server: server({ type: 'windows' }) })).toMatchObject({ kind: 'cmd' });
        expect(resolveChatEnvironment({ server: server({ type: 'windows' }), terminalOutput: 'Windows PowerShell\nPS C:\\Users\\admin> ' })).toMatchObject({ kind: 'powershell' });
    });

    it('uses PowerShell for the default local shell on Windows and the login shell elsewhere', () => {
        const local = server({ type: 'local' });
        expect(resolveChatEnvironment({ server: local, platform: 'win32' })).toMatchObject({ kind: 'powershell', location: 'local', osFamily: 'windows' });
        expect(resolveChatEnvironment({ server: local, platform: 'darwin', shellPath: '/bin/zsh' })).toMatchObject({ kind: 'posix', shellName: 'zsh', osFamily: 'macos' });
        expect(resolveChatEnvironment({ server: local, platform: 'linux', shellPath: '' })).toMatchObject({ kind: 'posix', shellName: 'bash' });
    });

    it('recognizes custom local commands and scoped CLI presets', () => {
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: 'cmd.exe /k' }), platform: 'win32' })).toMatchObject({ kind: 'cmd' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo' }), platform: 'win32' })).toMatchObject({ kind: 'powershell', shellName: 'PowerShell 7' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: 'wsl.exe' }), platform: 'win32' })).toMatchObject({ kind: 'posix' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: 'htop' }), platform: 'linux' })).toMatchObject({ kind: 'program', program: 'htop' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', cli_preset: 'docker' }) })).toMatchObject({ kind: 'scoped', scopedBin: 'docker', toolName: 'Docker' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', cli_preset: 'azure' }) })).toMatchObject({ kind: 'scoped', scopedBin: 'az' });
        // As the terminal opens them (shared/shells.ts): a preset in another case
        // is still its console, ash is a POSIX shell, a path or .exe is the program.
        expect(resolveChatEnvironment({ server: server({ type: 'local', cli_preset: 'Docker' }) })).toMatchObject({ kind: 'scoped', scopedBin: 'docker' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: '/bin/ash -l' }), platform: 'linux' })).toMatchObject({ kind: 'posix', shellName: 'ash' });
        expect(resolveChatEnvironment({ server: server({ type: 'local', command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo' }), platform: 'win32' }))
            .toMatchObject({ kind: 'powershell', shellName: 'PowerShell 7' });
    });

    it('handles FTP, S3 and no server', () => {
        expect(resolveChatEnvironment({ server: server({ type: 'ftp' }) })).toMatchObject({ kind: 'ftp' });
        expect(resolveChatEnvironment({ server: server({ type: 's3' }) })).toMatchObject({ kind: 'none' });
        expect(resolveChatEnvironment({ server: null })).toEqual({ kind: 'none', location: 'none', osFamily: 'unknown' });
    });
});

describe('classifyOs / promptShell', () => {
    it('classifies OS banners into families', () => {
        expect(classifyOs('Microsoft Windows [Version 10.0.20348.2340]')).toBe('windows');
        expect(classifyOs('Debian GNU/Linux 12 (bookworm)')).toBe('linux');
        expect(classifyOs('Darwin 23.4.0')).toBe('macos');
        expect(classifyOs('docker version 27.0')).toBe('unknown');
    });

    it('reads the last prompt only', () => {
        expect(promptShell('PS C:\\> dir\nC:\\>')).toBe('cmd');
        expect(promptShell('C:\\> powershell\nPS C:\\> ')).toBe('powershell');
        expect(promptShell('root@web:~# ')).toBeNull();
    });
});
