export default {
    title: 'Command palette',
    inputLabel: 'Search servers, tabs and commands',
    placeholder: 'Type a server, a tab or a command…',
    results: 'Results',
    empty: 'Nothing matches',
    current: '(current)',
    goToTab: 'Go to {tab}',
    sections: {
        servers: 'Servers',
        tabs: 'Tabs',
        actions: 'Tools',
        commands: 'Commands'
    },
    hints: {
        navigate: 'to move',
        run: 'to run',
        close: 'to close'
    },
    commands: {
        newConnection: 'New connection',
        importSshConfig: 'Import hosts from ~/.ssh/config',
        editActive: 'Edit {name}',
        closeActive: 'Close {name}',
        showChat: 'Show AI chat',
        hideChat: 'Hide AI chat',
        settings: 'Open settings',
        exportImport: 'Export or import the configuration',
        appearance: 'Appearance settings',
        keychain: 'Keychain: identities and SSH keys',
        theme: 'Theme: {theme}',
        language: 'Language: {language}',
        systemLanguage: 'System default'
    }
};
