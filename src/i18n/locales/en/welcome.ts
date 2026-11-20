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
        gpu: { title: 'GPU usage in Status', text: 'Utilization, temperature, power and GPU processes of NVIDIA servers' },
        spark: { title: 'DGX Spark support', text: 'Unified memory understood: no made-up VRAM, just what the machine reports' },
        model: { title: 'MiniMax M3.1 Flash by default', text: 'The recommended model, ready in every new chat' },
        pickers: { title: 'Groups and tags pickers', text: 'Existing groups and tags in the app\'s own dropdowns' }
    }
};
