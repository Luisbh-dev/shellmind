export default {
    action: 'Known hosts',
    title: 'Known hosts',
    description: 'SSH host keys trusted on first connection. Forget a key only after a legitimate change (e.g. a reinstalled server): the next connection trusts whatever key it gets.',
    search: 'Search known hosts',
    searchPlaceholder: 'Host, fingerprint or server name',
    loading: 'Loading known hosts…',
    loadFailed: 'Could not load the known hosts.',
    retry: 'Try again',
    empty: 'No host keys saved yet. ShellMind saves one the first time it connects to an SSH server.',
    noMatches: 'No known hosts match "{query}".',
    count: '{shown} of {total}',
    listLabel: 'Saved host keys',
    usedBy: 'Used by {servers}',
    notUsed: 'No saved server uses it',
    firstSeen: 'First seen {date}',
    // Before the jump hosts a key was seen through: "via 203.0.113.10:22 → 10.0.0.9:22".
    via: 'via',
    addressVia: '{address} via {route}',
    forget: 'Forget',
    forgetLabel: 'Forget the host key of {host}',
    copyFingerprint: 'Copy the fingerprint of {host}',
    copied: 'Fingerprint copied',
    copyFailed: 'Could not copy to the clipboard',
    forgotten: 'Host key of {host} forgotten',
    forgetFailed: 'Could not forget the host key',
    confirmForget: {
        title: 'Forget this host key?',
        message: 'The next connection to {host} will trust whatever key it presents. Do this only if you know why the key changed, for example after reinstalling the server.',
        confirm: 'Forget key'
    },
    card: {
        title: 'Host key',
        description: 'The key {address} presented the first time ShellMind connected. Connections are refused if it changes.',
        pending: 'No key saved for {address} yet: it is saved the first time ShellMind connects.',
        type: 'Type',
        fingerprint: 'Fingerprint',
        firstSeen: 'First seen',
        all: 'All known hosts'
    }
};
