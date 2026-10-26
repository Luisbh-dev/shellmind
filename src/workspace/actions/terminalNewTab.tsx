import { useEffect, useRef } from 'react';
import { PlusSquare } from 'lucide-react';
import { isDesktopApp, NEW_TERMINAL_TAB_SHORTCUT } from '@/features/terminal/platform';
import { useAppStore } from '@/store/appStore';
import type { GlobalAction, GlobalActionProps } from './types';

// Runs once and closes: the new tab shows up in the server's terminal panel.
function NewTerminalTab({ onClose, server }: GlobalActionProps) {
    const done = useRef(false);
    useEffect(() => {
        if (done.current) return;
        done.current = true;
        if (server) useAppStore.getState().openTerminalSession(server.id);
        onClose();
    }, [server, onClose]);
    return null;
}

const terminalNewTab: GlobalAction = {
    id: 'terminal-new-tab',
    order: 100,
    labelKey: 'terminal.actions.newSession',
    icon: PlusSquare,
    get shortcut() {
        return isDesktopApp() ? NEW_TERMINAL_TAB_SHORTCUT : undefined;
    },
    placement: 'palette',
    requiresServer: true,
    isAvailable: (server) => server !== null && server.type !== 's3',
    Component: NewTerminalTab
};

export default terminalNewTab;
