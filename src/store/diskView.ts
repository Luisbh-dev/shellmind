// W8-T4: opening the disk toolkit (src/features/disk) from anywhere: its
// global action id, the filesystem and part of the view it starts on (the
// Status page's disk rows ask for one), and the servers it works with. Kept
// outside the feature, so the status dashboard can open it without the two
// features depending on each other.
import { create } from 'zustand';
import type { WorkspaceServer } from '@/workspace/types';
import { useAppStore } from './appStore';

export const DISK_ACTION_ID = 'disk';

export type DiskView = 'usage' | 'files' | 'deleted' | 'cleanup';

// The filesystem (and part of the view) the next opening starts on, taken
// once: the palette opens the view on the fullest filesystem.
type DiskTarget = { serverId: number; mount: string | null; view: DiskView };

export const useDiskTarget = create<{ target: DiskTarget | null }>(() => ({ target: null }));

export function openDiskView(serverId: number, mount?: string, view: DiskView = 'usage'): void {
    useDiskTarget.setState({ target: { serverId, mount: mount ?? null, view } });
    useAppStore.getState().openAction(DISK_ACTION_ID);
}

export function peekDiskTarget(serverId: number): { mount: string | null; view: DiskView } {
    const { target } = useDiskTarget.getState();
    return target?.serverId === serverId ? { mount: target.mount, view: target.view } : { mount: null, view: 'usage' };
}

// Once the view has read it (an effect: React may render it twice first).
export function clearDiskTarget(): void {
    useDiskTarget.setState({ target: null });
}

// SSH-capable hosts, like the Status tab.
export const supportsDiskToolkit = (server: WorkspaceServer | null) => server !== null && !['ftp', 's3', 'local'].includes(server.type);
