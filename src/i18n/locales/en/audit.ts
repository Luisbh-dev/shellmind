export default {
    title: 'Audit log',
    subtitle: 'Commands run through ShellMind: AI, snippets, multi-exec and ops actions.',
    loading: 'Loading…',
    loadFailed: 'The audit log could not be loaded.',
    retry: 'Try again',
    refresh: 'Refresh',
    count: 'Entries: {count}',
    countMore: 'Showing the latest {count} entries',
    noServer: 'No server',
    toggleDetails: 'Show details',
    copyCommand: 'Copy command',
    reportedByClient: 'reported',
    reportedByClientHint: 'Reported by the interface after it typed the command into a terminal, not recorded by the backend on its own.',
    copied: 'Command copied',
    copyFailed: 'The clipboard is not available',
    loadOlder: 'Load older entries',
    filters: {
        search: 'Search',
        searchPlaceholder: 'Command or server',
        server: 'Server',
        allServers: 'All servers',
        source: 'Source',
        allSources: 'All sources',
        from: 'From',
        to: 'To',
        clear: 'Clear filters'
    },
    columns: {
        details: 'Details',
        time: 'Time',
        server: 'Server',
        source: 'Source',
        command: 'Command',
        exit: 'Exit',
        actions: 'Actions'
    },
    empty: {
        none: 'Nothing recorded yet. Commands run from the AI chat, snippets, multi-exec and ops panels appear here.',
        filtered: 'No entries match these filters.'
    },
    export: {
        csv: 'Export CSV',
        done: 'Exported entries: {count}',
        truncated: 'Only the latest {max} entries were exported. Narrow the filters to export the rest.',
        failed: 'The audit log could not be exported'
    },
    retention: {
        label: 'Keep entries',
        days: '{count} days',
        year: '1 year',
        forever: 'No time limit',
        foreverHint: 'Up to the newest {max} entries',
        confirmTitle: 'Delete older entries?',
        confirmMessage: 'Entries older than {period} are deleted now and every day from now on. The newest {max} entries are kept in any case.',
        confirm: 'Keep {period}',
        saved: 'Entries are kept for {period}',
        savedForever: 'Entries are kept without a time limit',
        pruned: '{count} older entries were deleted',
        prunedOne: '1 older entry was deleted',
        failed: 'The retention could not be changed'
    },
    sources: {
        'ai-run': 'AI',
        'ai-autorun': 'AI auto-run',
        snippet: 'Snippet',
        'multi-exec': 'Multi-exec',
        ops: 'Ops',
        terminal: 'Terminal',
        fleet: 'Fleet',
        identity: 'Identity',
        rdp: 'Remote desktop'
    }
};
