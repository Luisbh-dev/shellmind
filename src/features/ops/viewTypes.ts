import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { LogStreamSource, OpsCapabilities } from '@shared/ops';
import type { WorkspaceServer } from '@/workspace/types';

// The views of the Operations tab (src/features/ops/views/*.tsx, collected by
// viewRegistry.ts): a new view is a new file there, no list to edit.

// A live log asked for by another view; the Logs view starts it.
export type LogRequest = { source: LogStreamSource; nonce: number };

export type OpsViewProps = {
    server: WorkspaceServer;
    caps: OpsCapabilities;
    // Shows a live log in the Logs view.
    followLogs: (source: LogStreamSource) => void;
    // The latest such request (the Logs view only).
    logRequest: LogRequest | null;
};

export type OpsView = {
    id: string;
    // Position among the view tabs (services 10, containers 20, compose 30,
    // images 40, logs 90).
    order: number;
    labelKey: string;
    icon: LucideIcon;
    // What the server must offer for the view to be listed (always, if absent).
    isAvailable?: (caps: OpsCapabilities) => boolean;
    Component: ComponentType<OpsViewProps>;
};
