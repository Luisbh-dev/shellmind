import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore, type PaneCommand } from '@/store/appStore';
import type { GlobalAction, GlobalActionProps } from './types';

// Palette entries for the terminal panel's own keys (split, next pane,
// broadcast input), which were reachable only by their shortcuts and mouse
// buttons: each asks the panel of the server on screen (requestPaneCommand)
// and closes.
export function paneCommandAction(options: { id: string; order: number; labelKey: string; icon: LucideIcon; command: PaneCommand; keywords: string }): GlobalAction {
    function RunPaneCommand({ onClose, server }: GlobalActionProps) {
        const done = useRef(false);
        useEffect(() => {
            if (done.current) return;
            done.current = true;
            if (server) useAppStore.getState().requestPaneCommand(server.id, options.command);
            onClose();
        }, [server, onClose]);
        return null;
    }
    return {
        id: options.id,
        order: options.order,
        labelKey: options.labelKey,
        icon: options.icon,
        keywords: options.keywords,
        placement: 'palette',
        requiresServer: true,
        // While that server's terminal is on screen, with a tab open.
        isAvailable: (server) => {
            if (!server) return false;
            const state = useAppStore.getState();
            return state.visibleTerminalServer === server.id && Boolean(state.terminalSessions[server.id]?.sessions.length);
        },
        Component: RunPaneCommand
    };
}
