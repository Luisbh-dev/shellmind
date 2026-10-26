import { describe, expect, it } from 'vitest';
import {
    findMount,
    isValidFd,
    isValidPid,
    isValidProcessName,
    isWithinMount,
    mountOf,
    normalizePosixPath,
    normalizeWindowsPath,
    parentPath,
    pathTrail,
    resolveCleanupParams
} from './disk';

describe('POSIX paths', () => {
    it('normalizes absolute paths and refuses anything else', () => {
        expect(normalizePosixPath('/')).toBe('/');
        expect(normalizePosixPath('//var///log/')).toBe('/var/log');
        expect(normalizePosixPath("/srv/it's $HOME `x`")).toBe("/srv/it's $HOME `x`");
        expect(normalizePosixPath('var/log')).toBeNull();
        expect(normalizePosixPath('/var/../etc')).toBeNull();
        expect(normalizePosixPath('/var/./log')).toBeNull();
        expect(normalizePosixPath('/var/log\nrm -rf /')).toBeNull();
        expect(normalizePosixPath('/a\0b')).toBeNull();
        expect(normalizePosixPath(`/${'a'.repeat(5000)}`)).toBeNull();
    });
});

describe('Windows paths', () => {
    it('normalizes drive paths and refuses what Windows forbids in names', () => {
        expect(normalizeWindowsPath('c:\\')).toBe('C:\\');
        expect(normalizeWindowsPath('C:/Users//admin/')).toBe('C:\\Users\\admin');
        expect(normalizeWindowsPath("C:\\Users\\Bob's files")).toBe("C:\\Users\\Bob's files");
        expect(normalizeWindowsPath('C:')).toBeNull();
        expect(normalizeWindowsPath('\\\\server\\share')).toBeNull();
        expect(normalizeWindowsPath('C:\\a\\..\\b')).toBeNull();
        expect(normalizeWindowsPath('C:\\a"b')).toBeNull();
        expect(normalizeWindowsPath('C:\\a|b')).toBeNull();
        expect(normalizeWindowsPath('C:\\a:stream')).toBeNull();
    });
});

describe('mounts', () => {
    const mounts = [{ mount: '/' }, { mount: '/var' }, { mount: '/var/lib/docker' }];

    it('finds the filesystem a path is on (the longest mount point)', () => {
        expect(mountOf('linux', '/var/log', mounts)?.mount).toBe('/var');
        expect(mountOf('linux', '/variable', mounts)?.mount).toBe('/');
        expect(mountOf('linux', '/var/lib/docker/overlay2', mounts)?.mount).toBe('/var/lib/docker');
        expect(mountOf('windows', 'c:\\Users', [{ mount: 'C:\\' }, { mount: 'D:\\' }])?.mount).toBe('C:\\');
        expect(mountOf('windows', 'E:\\x', [{ mount: 'C:\\' }])).toBeNull();
        expect(isWithinMount('linux', '/var', '/var')).toBe(true);
        expect(isWithinMount('linux', '/varx', '/var')).toBe(false);
    });

    it('finds the filesystem a name refers to (Windows drives as the Status page names them)', () => {
        const drives = [{ mount: 'C:\\' }, { mount: 'D:\\' }];
        expect(findMount(mounts, '/var')?.mount).toBe('/var');
        expect(findMount(mounts, '/var/log')).toBeNull();
        expect(findMount(mounts, '/VAR')).toBeNull();
        expect(findMount(drives, 'D:')?.mount).toBe('D:\\');
        expect(findMount(drives, 'd:\\')?.mount).toBe('D:\\');
        expect(findMount(drives, 'C:\\')?.mount).toBe('C:\\');
        expect(findMount(drives, 'E:')).toBeNull();
        expect(findMount(drives, 'D:\\Users')).toBeNull();
    });

    it('walks up to the mount and builds the breadcrumb', () => {
        expect(parentPath('linux', '/var/log/nginx', '/var')).toBe('/var/log');
        expect(parentPath('linux', '/var/log', '/var')).toBe('/var');
        expect(parentPath('linux', '/var', '/var')).toBeNull();
        expect(parentPath('linux', '/srv', '/')).toBe('/');
        expect(parentPath('windows', 'C:\\Users', 'C:\\')).toBe('C:\\');
        expect(parentPath('windows', 'C:\\Users\\admin', 'C:\\')).toBe('C:\\Users');
        expect(pathTrail('linux', '/var/log/nginx', '/var')).toEqual([
            { name: '/var', path: '/var' }, { name: 'log', path: '/var/log' }, { name: 'nginx', path: '/var/log/nginx' }
        ]);
        expect(pathTrail('linux', '/', '/')).toEqual([{ name: '/', path: '/' }]);
        expect(pathTrail('windows', 'C:\\Windows\\Temp', 'C:\\').map((step) => step.name)).toEqual(['C:\\', 'Windows', 'Temp']);
    });
});

describe('cleanup parameters', () => {
    it('fills in the defaults and accepts only the listed choices', () => {
        expect(resolveCleanupParams('journal', {})).toEqual({ keepMB: 200, keepDays: 0 });
        expect(resolveCleanupParams('journal', { keepMB: '500', keepDays: 7 })).toEqual({ keepMB: 500, keepDays: 7 });
        expect(resolveCleanupParams('rotated-logs', { days: 30 })).toEqual({ days: 30 });
        expect(resolveCleanupParams('package-cache', {})).toEqual({});
        expect(resolveCleanupParams('rotated-logs', { days: 5 })).toBeNull();
        expect(resolveCleanupParams('rotated-logs', { days: '7; rm -rf /' })).toBeNull();
        expect(resolveCleanupParams('package-cache', { days: 7 })).toBeNull();
        expect(resolveCleanupParams('tmp', { days: undefined, keepMB: '' })).toEqual({ days: 10 });
    });
});

describe('process references', () => {
    it('accepts kernel pids, descriptors and comm names only', () => {
        expect(isValidPid(1234)).toBe(true);
        expect(isValidPid(1)).toBe(false);
        expect(isValidPid('1234')).toBe(false);
        expect(isValidPid(1.5)).toBe(false);
        expect(isValidFd(0)).toBe(true);
        expect(isValidFd(-1)).toBe(false);
        expect(isValidProcessName('nginx: worker')).toBe(true);
        expect(isValidProcessName('a\nb')).toBe(false);
        expect(isValidProcessName('')).toBe(false);
    });
});
