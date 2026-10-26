export default {
    title: 'Welcome to ShellMind',
    subtitle: 'Your self-hosted workspace for SSH, files, operations and AI.',
    actions: 'Get started',
    newConnection: {
        title: 'New connection',
        text: 'SSH, Windows, FTP, S3 or a local CLI'
    },
    importSsh: {
        title: 'Import ~/.ssh/config',
        text: 'Bring in the hosts you already use'
    },
    localShell: {
        title: 'Open a local shell',
        text: 'A terminal on this machine',
        name: 'Local shell',
        confirmTitle: 'Create a local shell?',
        confirmMessage: 'There is no local shell among your connections yet. Create “{name}” and open it?',
        confirm: 'Create and open',
        failed: 'Could not create the local shell',
        listFailed: 'The local shell opens once your connections have loaded. Try again in a moment.'
    },
    palette: {
        title: 'Command palette',
        text: 'Servers, tabs and actions, by name'
    },
    recent: 'Recent',
    connections: 'Your connections',
    lastOpened: 'Opened {when}',
    notOpened: 'Not opened yet',
    loading: 'Loading connections',
    attention: {
        title: 'Needs attention',
        open: 'Open fleet health',
        setupTitle: 'Fleet health',
        setupText: 'See which servers need attention at a glance, and get notified when one turns critical.',
        setup: 'Set up',
        allGood: 'All {count} checked servers are healthy',
        allGoodOne: 'The checked server is healthy',
        more: '+{count} more',
        checked: 'Checked {when}'
    },
    whatsNew: {
        title: 'New in {version}',
        fleet: { title: 'Fleet health', text: 'Every server\'s health on one screen, with alerts' },
        panes: { title: 'Split panes & broadcast', text: 'Terminals side by side, one line typed into many' },
        containers: { title: 'Containers & Kubernetes', text: 'Compose, images, pods and workloads, with shells inside' },
        patch: { title: 'Patch center & disk toolkit', text: 'Updates in safe batches, disk cleanups with a preview' },
        rdp: { title: 'Built-in Remote Desktop', text: 'Windows desktops in a tab, certificates pinned' },
        diagnose: { title: 'AI diagnose', text: 'Evidence from the server, then the cause and the fix' },
        jobs: { title: 'Multi-exec jobs', text: 'Canary rollouts, output grouped by result' },
        security: { title: 'Keychain & audit', text: 'Shared identities, SSH agent, encrypted credentials, audit log' },
        appearance: { title: 'Themes & languages', text: 'Light and dark, accent colors, English and Spanish' }
    }
};
