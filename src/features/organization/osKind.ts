// Which icon a saved server gets: the kind of connection (FTP, S3, a local
// shell or cloud CLI) or, for SSH servers, the OS its sessions detected
// (os_detail, e.g. "Ubuntu 24.04.1 LTS" or "Microsoft Windows Server 2022").
import { scopedPresetKey } from '@shared/shells';
import type { ServerSummary } from '@shared/types';

export const OS_KINDS = [
    'ubuntu', 'debian', 'alpine', 'rhel', 'centos', 'rocky', 'alma', 'fedora', 'arch', 'suse', 'windows', 'macos',
    'freebsd', 'linux', 'server', 'local', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'ftp', 's3'
] as const;
export type OsKind = typeof OS_KINDS[number];

const PRESET_KINDS: Record<string, OsKind> = {
    docker: 'docker',
    kubectl: 'kubernetes',
    aws: 'aws',
    azure: 'azure',
    gcloud: 'gcp'
};

// First match wins: distributions before the "Linux" in their names.
const OS_PATTERNS: Array<[RegExp, OsKind]> = [
    [/windows|microsoft/, 'windows'],
    [/ubuntu/, 'ubuntu'],
    [/debian|raspbian|raspberry pi os/, 'debian'],
    [/alpine/, 'alpine'],
    [/rocky/, 'rocky'],
    [/alma/, 'alma'],
    [/cent ?os/, 'centos'],
    [/red ?hat|\brhel\b/, 'rhel'],
    [/fedora/, 'fedora'],
    // "Arch Linux", an Arch kernel ("6.6.10-arch1-1"), not "aarch64".
    [/(^|[^a-z])arch([^a-z]|$)|manjaro|endeavouros/, 'arch'],
    [/suse|\bsles\b/, 'suse'],
    [/darwin|mac ?os|os x/, 'macos'],
    [/freebsd/, 'freebsd'],
    [/linux|gnu|kali|gentoo|nixos|amazon|oracle|mint|pop!_os|elementary|zorin|void|slackware|photon/, 'linux']
];

export function osKindOf(server: Pick<ServerSummary, 'type' | 'os_detail' | 'cli_preset'>): OsKind {
    if (server.type === 'ftp') return 'ftp';
    if (server.type === 's3') return 's3';
    if (server.type === 'local') return PRESET_KINDS[scopedPresetKey(server.cli_preset) ?? ''] ?? 'local';
    const detail = (server.os_detail ?? '').toLowerCase();
    for (const [pattern, kind] of OS_PATTERNS) {
        if (pattern.test(detail)) return kind;
    }
    return server.type === 'windows' ? 'windows' : 'server';
}
