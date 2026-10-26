import { useEffect, useRef } from 'react';
import { XSquare } from 'lucide-react';
import { CLOSE_TERMINAL_TAB_SHORTCUT, isDesktopApp } from '@/features/terminal/platform';
import { useAppStore } from '@/store/appStore';
import type { GlobalAction, GlobalActionProps } from './types';

// Closes the focused terminal tab of the active server, then itself.
function CloseTerminalTab({ onClose, server }: GlobalActionProps) {
    const done = useRef(false);
    useEffect(() => {
        if (done.current) return;
        done.current = true;
        const store = useAppStore.getState();
        const focusedId = server ? store.terminalSessions[server.id]?.focusedId : null;
        if (server && focusedId) store.closeTerminalSession(server.id, focusedId);
        onClose();
    }, [server, onClose]);
    return null;
}

// Only while that server's terminal is on screen: the tab it closes (and the
// shell with whatever runs in it) is then the one the user is looking at.
const terminalCloseTab: GlobalAction = {
    id: 'terminal-close-tab',
    order: 101,
    labelKey: 'terminal.actions.closeSession',
    icon: XSquare,
    get shortcut() {
        return isDesktopApp() ? CLOSE_TERMINAL_TAB_SHORTCUT : undefined;
    },
    placement: 'palette',
    requiresServer: true,
    isAvailable: (server) => {
        if (!server) return false;
        const state = useAppStore.getState();
        return state.visibleTerminalServer === server.id && Boolean(state.terminalSessions[server.id]?.sessions.length);
    },
    Component: CloseTerminalTab
};

export default terminalCloseTab;
