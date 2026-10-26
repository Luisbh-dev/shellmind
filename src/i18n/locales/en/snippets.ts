export default {
    title: 'Snippets',
    subtitle: 'Saved commands and runbook steps, with {{variables}} you fill in before running.',
    search: 'Search snippets',
    showAllScopes: 'Include snippets of other servers',
    tagFilter: 'Filter by tag',
    clearTags: 'Clear',
    listLabel: 'Snippets',
    loading: 'Loading snippets…',
    loadFailed: 'The snippets could not be loaded.',
    retry: 'Try again',
    copyName: '{name} (copy)',
    empty: {
        noMatch: 'No snippet matches these filters.',
        library: 'Your library is empty. Save the commands you run often and reuse them on any server.',
        short: 'No snippets yet.'
    },
    actions: {
        new: 'New snippet',
        starters: 'Starter snippets',
        edit: 'Edit snippet',
        duplicate: 'Duplicate snippet',
        delete: 'Delete snippet',
        runIn: 'Run in {server}',
        runInTerminal: 'Run in terminal',
        runOnMany: 'Run on several servers…',
        openInMultiExec: 'Open in multi-exec…',
        copy: 'Copy'
    },
    scope: {
        global: 'All servers',
        globalHint: 'Available on every server',
        onlyOn: 'Only {server}'
    },
    detail: {
        template: 'Template',
        command: 'Command',
        preview: 'Command to run',
        noServer: 'Select a connection to run it in its terminal.',
        noTerminal: 'This connection has no terminal.',
        otherServer: 'This snippet belongs to {server}. Duplicate it for all servers to run it here.',
        noMultiExec: 'Multi-exec runs on SSH servers only, and this snippet belongs to {server}.',
        secretsHidden: 'Secret values are hidden: the audit log and the terminal history record their {{placeholder}}, and the AI chat reads the terminal with them masked. Typed into a terminal, the shell still shows the value on screen.'
    },
    variables: {
        title: 'Variables',
        required: 'Required',
        empty: '(empty)',
        missing: 'Enter a value.',
        requiredHint: 'No default value.',
        defaultHint: 'Default: {value}',
        secret: 'Secret',
        markSecret: 'Treat {name} as a secret',
        secretHint: 'Secret: never recorded or remembered.',
        fillIn: 'Fill in: {list}'
    },
    editor: {
        newTitle: 'New snippet',
        editTitle: 'Edit snippet',
        name: 'Name',
        namePlaceholder: 'Restart the web stack',
        nameRequired: 'Give the snippet a name.',
        description: 'Description',
        descriptionPlaceholder: 'What it does and when to use it',
        command: 'Command',
        commandRequired: 'Enter the command to run.',
        commandHint: 'Multi-line scripts are fine. Use {example} for a value asked before running, {exampleDefault} for one with a default, or {exampleSecret} for a secret (never recorded); write {escaped} to keep the braces as they are. Go templates ({{.Names}}, {{end}}) are left alone.',
        noVariables: 'No variables.',
        variables: 'Variables: {list}',
        secretVariable: '{name} (secret)',
        tags: 'Tags',
        tagsHint: 'Separate tags with commas.',
        tagsPlaceholder: 'disk, nginx, weekly',
        scope: 'Available on',
        save: 'Save snippet'
    },
    delete: {
        title: 'Delete snippet',
        message: '"{name}" will be removed from your library.',
        confirm: 'Delete'
    },
    toasts: {
        created: 'Snippet saved',
        updated: 'Snippet updated',
        deleted: 'Snippet deleted',
        deleteFailed: 'The snippet could not be deleted',
        imported: 'Snippets imported: {count}',
        skipped: 'Already in your library: {count}',
        importFailed: 'The snippets could not be imported',
        sent: 'Sent to the terminal of {server}',
        queued: 'Waiting for the terminal of {server}: it runs once the session is connected, or is dropped after {minutes} minutes',
        copied: 'Command copied',
        copyFailed: 'The clipboard is not available'
    },
    // Why the backend refused a snippet (INVALID_SNIPPET details.reason).
    errors: {
        nameRequired: 'Give the snippet a name.',
        nameTooLong: 'The name can have at most {max} characters.',
        commandRequired: 'Enter the command to run.',
        commandTooLong: 'The command can have at most {max} characters.',
        descriptionTooLong: 'The description can have at most {max} characters.',
        tagTooLong: 'Each tag can have at most {max} characters.',
        tooManyTags: 'A snippet can have at most {max} tags.',
        serverNotFound: 'The server this snippet is for no longer exists. Choose another one.'
    },
    starters: {
        title: 'Starter snippets',
        introEmpty: 'Start your library with a few everyday checks. They become your own snippets: edit them as you like.',
        intro: 'Add common checks to your library. Snippets you already have are skipped.',
        notNow: 'Not now',
        import: 'Import selected ({count})',
        diskUsage: {
            name: 'Disk usage',
            description: 'Space used on every real filesystem.'
        },
        topMemory: {
            name: 'Top memory processes',
            description: 'Processes using the most memory.'
        },
        failedUnits: {
            name: 'Failed systemd units',
            description: 'Services and units that failed.'
        },
        dockerPs: {
            name: 'Running containers',
            description: 'Docker containers with their image, status and ports.'
        },
        tailSyslog: {
            name: 'Tail the system log',
            description: 'Last lines of the system log (or any file).'
        },
        openPorts: {
            name: 'Listening ports',
            description: 'TCP and UDP sockets waiting for connections.'
        }
    }
};
