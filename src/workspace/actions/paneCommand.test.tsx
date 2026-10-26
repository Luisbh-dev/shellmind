import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '../types';
import terminalBroadcast from './terminalBroadcast';
import terminalSplitDown from './terminalSplitDown';

// UX-09: a pane command picked in the palette asks the server's terminal
// panel (TerminalPanel consumes it) and closes at once.

const server: WorkspaceServer = { id: 7, name: 'web', ip: '10.0.0.7', type: 'linux' };

afterEach(() => useAppStore.setState({ paneCommand: null }));

describe('terminal pane commands', () => {
    it('ask the panel of the server, then close', () => {
        const onClose = vi.fn();
        render(<terminalBroadcast.Component onClose={onClose} server={server} />);
        expect(useAppStore.getState().paneCommand).toMatchObject({ serverId: 7, command: 'toggle-broadcast' });
        expect(onClose).toHaveBeenCalledTimes(1);

        render(<terminalSplitDown.Component onClose={onClose} server={server} />);
        expect(useAppStore.getState().paneCommand).toMatchObject({ serverId: 7, command: 'split-down' });
    });

    it('ask nothing without a server', () => {
        const onClose = vi.fn();
        render(<terminalBroadcast.Component onClose={onClose} server={null} />);
        expect(useAppStore.getState().paneCommand).toBeNull();
        expect(onClose).toHaveBeenCalled();
    });
});
