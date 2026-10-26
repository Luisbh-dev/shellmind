import { describe, expect, it } from 'vitest';
import type { ServerType } from '@shared/types';
import { osKindOf, type OsKind } from './osKind';

const ssh = (os_detail: string | null, type: ServerType = 'linux') => ({ type, os_detail, cli_preset: null });

describe('osKindOf', () => {
    it.each<[string, OsKind]>([
        ['Ubuntu 24.04.1 LTS', 'ubuntu'],
        ['Debian GNU/Linux 12 (bookworm)', 'debian'],
        ['Raspbian GNU/Linux 11 (bullseye)', 'debian'],
        ['Alpine Linux v3.20', 'alpine'],
        ['Rocky Linux 9.4 (Blue Onyx)', 'rocky'],
        ['AlmaLinux 9.4 (Seafoam Ocelot)', 'alma'],
        ['CentOS Stream 9', 'centos'],
        ['CentOS Linux 7 (Core)', 'centos'],
        ['Red Hat Enterprise Linux 9.2 (Plow)', 'rhel'],
        ['Fedora Linux 40 (Workstation Edition)', 'fedora'],
        ['Arch Linux', 'arch'],
        ['Linux 6.6.10-arch1-1', 'arch'],
        ['Manjaro Linux', 'arch'],
        ['openSUSE Leap 15.5', 'suse'],
        ['SUSE Linux Enterprise Server 15 SP5', 'suse'],
        ['Microsoft Windows Server 2022 Datacenter', 'windows'],
        ['Microsoft Windows [Version 10.0.26100.1]', 'windows'],
        ['macOS 14.5', 'macos'],
        ['Darwin 23.5.0', 'macos'],
        ['FreeBSD 14.1-RELEASE', 'freebsd'],
        ['Amazon Linux 2023', 'linux'],
        ['Pop!_OS 22.04 LTS', 'linux'],
        ['Linux Mint 21.3', 'linux'],
        ['Linux 5.15.0-91-generic', 'linux'],
        ['Linux 6.1.0-aarch64', 'linux']
    ])('%s is %s', (detail, kind) => {
        expect(osKindOf(ssh(detail))).toBe(kind);
    });

    it('falls back to the server type before an OS is detected', () => {
        expect(osKindOf(ssh(null))).toBe('server');
        expect(osKindOf(ssh(''))).toBe('server');
        expect(osKindOf(ssh(null, 'windows'))).toBe('windows');
        expect(osKindOf(ssh('SunOS 5.11'))).toBe('server');
    });

    it('uses the protocol for FTP and S3 whatever the detected OS', () => {
        expect(osKindOf({ type: 'ftp', os_detail: 'Ubuntu 22.04', cli_preset: null })).toBe('ftp');
        expect(osKindOf({ type: 's3', os_detail: null, cli_preset: null })).toBe('s3');
    });

    it('shows local consoles by their CLI preset', () => {
        const local = (cli_preset: string | null) => osKindOf({ type: 'local', os_detail: 'Windows_NT 10.0.26100', cli_preset });
        expect(local('docker')).toBe('docker');
        expect(local('kubectl')).toBe('kubernetes');
        expect(local('aws')).toBe('aws');
        expect(local('azure')).toBe('azure');
        expect(local('gcloud')).toBe('gcp');
        expect(local('shell')).toBe('local');
        expect(local('custom')).toBe('local');
        expect(local(null)).toBe('local');
    });
});
