import { lazyWithRetry } from '@/lib/lazy';
import { Terminal as TerminalIcon } from 'lucide-react';
import { appendTerminalOutput, focusTerminalOutput } from '@/store/terminalOutput';
import { TERMINAL_TAB_ID, type WorkspaceTab } from '../types';

// xterm and its addons load with the first terminal, not with the app.
const TerminalComponent = lazyWithRetry(() => import('@/features/terminal/TerminalPanel'));

const terminalTab: WorkspaceTab = {
    id: TERMINAL_TAB_ID,
    order: 10,
    labelKey: (server) => {
        if (server.type === 'ftp' || server.type === 'local') return 'app.tabs.terminal';
        return server.type === 'windows' ? 'app.tabs.windowsShell' : 'app.tabs.ssh';
    },
    icon: TerminalIcon,
    isAvailable: (server) => server.type !== 's3',
    // The terminal reports the server's connection (header, sidebar, chat)
    // and runs the commands queued for it, so it connects as the server
    // opens. A Windows server opens on its Remote Desktop instead: its SSH
    // shell (OpenSSH is often not running there) connects when its tab is
    // first opened, or when a command is sent to it.
    mountsWithServer: (server) => server.type !== 'windows',
    // Hidden terminals keep their sessions; commands queued for the server are
    // delivered to its focused tab whether or not the panel is visible. The
    // focused tab's output also feeds the per-server buffer the AI chat reads
    // (src/store/terminalOutput.ts), which follows the focus between tabs.
    Component: ({ server, isActive, onOsDetected, onTerminalOutput }) => (
        <TerminalComponent
            server={server}
            isActive={isActive}
            onOsDetected={onOsDetected}
            onOutput={(data, sessionId, size) => {
                appendTerminalOutput(server.id, data, sessionId, size);
                onTerminalOutput(data);
            }}
            onSessionFocused={(sessionId, screen) => focusTerminalOutput(server.id, sessionId, screen)}
        />
    )
};

export default terminalTab;
