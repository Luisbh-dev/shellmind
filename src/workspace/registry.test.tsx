import { describe, expect, it, vi } from 'vitest';
import type { ServerType } from '@shared/types';
import { catalog } from '@/i18n/catalog';
import { getAvailableTabs, getDefaultTab, tabLabelKey, workspaceTabs } from './registry';
import type { WorkspaceServer } from './types';

// The descriptors are under test, not the panels (xterm needs a real canvas).
vi.mock('@/features/terminal/TerminalPanel', () => ({ default: () => null }));
vi.mock('@/features/files/FileExplorer', () => ({ default: () => null }));
vi.mock('@/features/status/StatusDashboard', () => ({ default: () => null }));
vi.mock('@/features/ops/OperationsPanel', () => ({ default: () => null }));
vi.mock('@/features/rdp/RdpPanel', () => ({ default: () => null }));
// --- W8-T2 Kubernetes ---
vi.mock('@/features/k8s/KubernetesPanel', () => ({ default: () => null }));

const server = (type: ServerType): WorkspaceServer => ({ id: 1, name: 'host', ip: '10.0.0.1', type });

describe('workspace tab registry', () => {
    it('collects every file in tabs/ ordered by `order`', () => {
        expect(workspaceTabs.map((tab) => tab.id)).toEqual(['terminal', 'files', 'status', 'operations', 'kubernetes', 'rdp', 'tunnels']);
    });

    it.each<[ServerType, string[], string]>([
        ['linux', ['terminal', 'files', 'status', 'operations', 'tunnels'], 'terminal'],
        // A Windows server opens on its Remote Desktop (embedded client).
        ['windows', ['terminal', 'files', 'status', 'operations', 'rdp', 'tunnels'], 'rdp'],
        ['ftp', ['terminal', 'files'], 'files'],
        ['s3', ['files'], 'files'],
        ['local', ['terminal'], 'terminal']
    ])('%s connections get %j and open on %s', (type, tabs, defaultTab) => {
        expect(getAvailableTabs(server(type)).map((tab) => tab.id)).toEqual(tabs);
        expect(getDefaultTab(server(type))?.id).toBe(defaultTab);
    });

    // Its terminal reports the connection and runs queued commands; a Windows
    // server's SSH shell waits for its tab (OpenSSH often does not run there).
    it('mounts the terminal with every server but a Windows one', () => {
        const mounted = (type: ServerType) => getAvailableTabs(server(type)).filter((tab) => tab.mountsWithServer?.(server(type))).map((tab) => tab.id);
        expect(mounted('linux')).toEqual(['terminal']);
        expect(mounted('ftp')).toEqual(['terminal']);
        expect(mounted('local')).toEqual(['terminal']);
        expect(mounted('windows')).toEqual([]);
        expect(mounted('s3')).toEqual([]);
    });

    it('labels the terminal tab after the kind of shell', () => {
        const terminal = workspaceTabs.find((tab) => tab.id === 'terminal')!;
        expect(tabLabelKey(terminal, server('linux'))).toBe('app.tabs.ssh');
        expect(tabLabelKey(terminal, server('windows'))).toBe('app.tabs.windowsShell');
        expect(tabLabelKey(terminal, server('ftp'))).toBe('app.tabs.terminal');
        expect(tabLabelKey(terminal, server('local'))).toBe('app.tabs.terminal');
    });

    // --- W8-T2 Kubernetes ---
    // kubectl runs on a Linux server, or on this computer for a local
    // connection with the kubectl preset (not for a plain local shell). A
    // Linux server has the tab once kubectl was found on it.
    it('offers Kubernetes to local kubectl connections, and to Linux servers where kubectl was found', () => {
        const local = (cli_preset: string | null): WorkspaceServer => ({ ...server('local'), cli_preset });
        expect(getAvailableTabs(local('kubectl')).map((tab) => tab.id)).toEqual(['terminal', 'kubernetes']);
        expect(getAvailableTabs(local(' Kubectl ')).map((tab) => tab.id)).toEqual(['terminal', 'kubernetes']);
        expect(getAvailableTabs(local('docker')).map((tab) => tab.id)).toEqual(['terminal']);
        expect(getAvailableTabs(local('shell')).map((tab) => tab.id)).toEqual(['terminal']);
        expect(getDefaultTab(local('kubectl'))?.id).toBe('terminal');
        try {
            localStorage.setItem('shellmind.k8s.presence.1', JSON.stringify({ presence: 'present', version: null }));
            expect(getAvailableTabs(server('linux')).map((tab) => tab.id)).toEqual(['terminal', 'files', 'status', 'operations', 'kubernetes', 'tunnels']);
            expect(getAvailableTabs(server('windows')).map((tab) => tab.id)).not.toContain('kubernetes');
        } finally {
            localStorage.clear();
        }
    });

    it('only uses label keys that exist in the catalog', () => {
        const types: ServerType[] = ['linux', 'windows', 'ftp', 's3', 'local'];
        const keys = workspaceTabs.flatMap((tab) => types.map((type) => tabLabelKey(tab, server(type))));
        expect(keys.filter((key) => !(key in catalog.en))).toEqual([]);
    });
});
