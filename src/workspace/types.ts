import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ServerSummary } from '@shared/types';

// The active connection as the workspace sees it: the saved server plus the
// OS detected by its live session.
export type WorkspaceServer = ServerSummary & { osDetail?: string };

export interface WorkspaceTabProps {
    server: WorkspaceServer;
    // The panel is the visible tab (hidden panels stay mounted).
    isActive: boolean;
    onOsDetected: (os: string) => void;
    onTerminalOutput: (data: string) => void;
}

// One workspace tab. Each file in ./tabs default-exports a descriptor and is
// picked up by the registry; nothing else needs to change to add a panel.
export interface WorkspaceTab {
    id: string;
    // Position in the tab bar (ascending).
    order: number;
    // i18n key of the tab label; a function when it depends on the server.
    labelKey: string | ((server: WorkspaceServer) => string);
    icon: LucideIcon;
    isAvailable: (server: WorkspaceServer) => boolean;
    // Opened first when the server is selected (otherwise the first tab is).
    isPreferredFor?: (server: WorkspaceServer) => boolean;
    // Mounted as soon as the server opens, shown or not (other panels mount
    // the first time their tab is opened).
    mountsWithServer?: (server: WorkspaceServer) => boolean;
    Component: ComponentType<WorkspaceTabProps>;
}

// Commands sent to a server from the chat run in this tab.
export const TERMINAL_TAB_ID = 'terminal';
