import type { WorkspaceServer, WorkspaceTab } from './types';

const modules = import.meta.glob<WorkspaceTab>('./tabs/*.tsx', { eager: true, import: 'default' });

export const workspaceTabs: readonly WorkspaceTab[] = Object.values(modules).sort((a, b) => a.order - b.order);

export function getAvailableTabs(server: WorkspaceServer): WorkspaceTab[] {
    return workspaceTabs.filter((tab) => tab.isAvailable(server));
}

export function getDefaultTab(server: WorkspaceServer): WorkspaceTab | undefined {
    const available = getAvailableTabs(server);
    return available.find((tab) => tab.isPreferredFor?.(server)) ?? available[0];
}

export function tabLabelKey(tab: WorkspaceTab, server: WorkspaceServer): string {
    return typeof tab.labelKey === 'function' ? tab.labelKey(server) : tab.labelKey;
}
