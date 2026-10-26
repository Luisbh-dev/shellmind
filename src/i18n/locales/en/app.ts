export default {
    noConnection: 'No connection selected',
    reconnectHint: 'The connection settings changed. Reconnect the session to use them.',
    reorderFailed: 'Could not save the new order',
    sidebar: 'Connections',
    skipToWorkspace: 'Skip to the workspace',
    chat: {
        open: 'Open Chat',
        close: 'Close Chat',
        toggle: 'AI chat',
        panel: 'AI chat',
        disabledS3: 'The AI assistant is not available for S3 buckets'
    },
    palette: {
        open: 'Open the command palette',
        placeholder: 'Search or run a command…'
    },
    resize: {
        sidebar: 'Resize the connections panel',
        chat: 'Resize the chat panel'
    },
    openServers: {
        count: '{count} open',
        countHint: 'Up to {max} connections stay open in the background, sessions included.',
        closeTitle: 'Close {name}?',
        closeMessage: 'Closing {name} ends this work:',
        close: 'Close {name}',
        evictTitle: 'Close {name} to make room?',
        evictMessage: 'Up to {max} connections stay open. Opening {opening} closes the least recently used one, {name}, which ends this work:',
        work: {
            session: '1 live terminal session',
            sessions: '{count} live terminal sessions',
            unsavedFile: 'Unsaved changes to {path}',
            transfer: '1 file transfer in progress',
            transfers: '{count} file transfers in progress'
        }
    },
    shortcuts: {
        palette: 'Command palette',
        paletteTerminal: 'Command palette, also inside the terminal (there Ctrl+K belongs to the shell)',
        toggleChat: 'Show or hide the AI chat',
        settings: 'Settings',
        tabs: 'Switch workspace tab',
        regions: 'Move between the connections, the workspace and the AI chat',
        regionsTerminal: 'The same from inside the terminal (there F6 belongs to the program)',
        contextMenu: 'Open the menu of a connection, a tab or the terminal',
        menuKey: 'Menu key',
        groups: {
            general: 'General',
            actions: 'Tools',
            terminal: 'Terminal'
        },
        terminal: {
            copy: 'Copy the selection',
            paste: 'Paste',
            search: 'Search the output',
            toolbar: 'Go to the terminal toolbar',
            renameTab: 'Rename the focused terminal tab',
            closeTab: 'Close the focused terminal tab'
        }
    },
    tabs: {
        label: 'Workspace',
        all: 'All tabs',
        terminal: 'Terminal',
        windowsShell: 'CMD / PowerShell',
        ssh: 'SSH',
        files: 'Files',
        status: 'Status',
        rdp: 'RDP'
    },
    commandQueue: {
        one: '1 command is waiting for the terminal. It runs as soon as the session is connected, or is dropped after {minutes} minutes.',
        many: '{count} commands are waiting for the terminal. They run as soon as the session is connected, or are dropped after {minutes} minutes.',
        discard: 'Discard',
        noServerHint: 'Commands run in the terminal of the active connection.',
        discardedOnClose: 'Queued commands for {name} were discarded ({count})',
        expired: 'Queued commands for {name} did not run within {minutes} minutes and were dropped ({count})'
    },
    ui: {
        showSecret: 'Show password',
        notifications: 'Notifications',
        removeTag: 'Remove tag {tag}'
    },
    errorBoundary: {
        title: 'Something went wrong',
        description: 'ShellMind hit an unexpected error. Your saved connections are safe: try again, or reload the app.',
        retry: 'Try again',
        reload: 'Reload app',
        copy: 'Copy details',
        copied: 'Copied',
        panelTitle: '{panel} stopped working',
        panelTitleGeneric: 'This panel stopped working',
        reloadPanel: 'Reload panel',
        chunkFailed: 'Its code could not be downloaded. Check the connection to ShellMind and reload the panel; if ShellMind was updated meanwhile, reload the app.'
    }
};
