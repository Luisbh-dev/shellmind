import { describe, expect, it } from 'vitest';
import { defaultPort, effectivePort } from './ports';

describe('defaultPort', () => {
    it('knows the port of each type and purpose', () => {
        expect(defaultPort('linux', 'terminal')).toBe(22);
        expect(defaultPort('linux', 'status')).toBe(22);
        expect(defaultPort('linux', 'rdp')).toBeNull();
        expect(defaultPort('windows', 'rdp')).toBe(3389);
        expect(defaultPort('windows', 'terminal')).toBe(22);
        expect(defaultPort('windows', 'files')).toBe(22);
        expect(defaultPort('ftp', 'files')).toBe(21);
        expect(defaultPort('ftp', 'terminal')).toBe(21);
        expect(defaultPort('ftp', 'status')).toBeNull();
        expect(defaultPort('s3', 'files')).toBeNull();
        expect(defaultPort('local', 'terminal')).toBeNull();
    });
});

describe('effectivePort', () => {
    it('uses ssh_port for SSH to Windows and port for everything else', () => {
        const windows = { type: 'windows' as const, port: 3390, ssh_port: 2222 };
        expect(effectivePort(windows, 'rdp')).toBe(3390);
        expect(effectivePort(windows, 'terminal')).toBe(2222);
        expect(effectivePort({ type: 'linux', port: 2200, ssh_port: 2222 }, 'terminal')).toBe(2200);
    });

    it('falls back to the default for blank ports', () => {
        expect(effectivePort({ type: 'ftp', port: null }, 'files')).toBe(21);
        expect(effectivePort({ type: 'windows', port: 0, ssh_port: null }, 'rdp')).toBe(3389);
        expect(effectivePort({ type: 'windows', port: 3389 }, 'status')).toBe(22);
        expect(effectivePort({ type: 's3', port: 22 }, 'files')).toBeNull();
    });
});
