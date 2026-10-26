export default {
    title: 'AI Assistant',
    clear: {
        label: 'Clear conversation',
        title: 'Clear conversation',
        message: 'Delete the saved chat history for this server? The AI loses the context of this conversation.',
        confirm: 'Clear'
    },
    greeting: {
        noServer: 'ShellMind AI is ready. Select a server to begin.',
        s3: 'Browsing {name}. The AI chat is not available for object storage.',
        connected: 'Connected to {name}. Ready to help.',
        connecting: 'Connecting to {name}…',
        error: "Couldn't connect to {name}. I can still help: check the issue below or ask me anything.",
        errorNoIssue: "Couldn't connect to {name}. I can still help: ask me anything.",
        disconnected: 'The session to {name} ended. Reconnect from the terminal, or ask me anything.',
        // A Windows server opens on its Remote Desktop: its shell connects later.
        idle: 'The shell of {name} is not connected yet: it connects when you open its tab or run a command from here. Ask me anything meanwhile.',
        detected: 'Detected: {os}',
        // The focused terminal tab is a shell inside a container (W7-S3).
        containerShell: 'The selected terminal tab is a shell inside the container {container} ({engine}): commands you send from here wait for you to choose where they run, and Auto-Run does not type there.'
    },
    model: {
        label: 'AI model',
        recommended: 'Recommended model',
        saveFailed: "Couldn't save the model preference"
    },
    roles: {
        user: 'You',
        assistant: 'ShellMind'
    },
    composer: {
        label: 'Message for the AI assistant',
        placeholder: 'Ask anything, or describe what you want to do…',
        send: 'Send (Enter)',
        stop: 'Stop',
        hint: 'Enter to send · Shift+Enter for a new line',
        tooLong: 'Too long: {count} / {max} characters',
        context: 'Context: {name}',
        noContext: 'Context: none'
    },
    messages: {
        label: 'Conversation',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        regenerate: 'Regenerate',
        retry: 'Try again',
        stopped: 'Stopped',
        cutOff: 'The answer was cut off by the token limit.',
        thinking: 'ShellMind is thinking…',
        answering: 'ShellMind is answering…',
        answerReady: 'Answer ready',
        jumpToLatest: 'Jump to latest',
        commandOutput: 'Output of {command}',
        stillRunning: 'still running',
        lines: '{count} lines',
        loadingHistory: 'Loading the saved conversation…',
        historyUnavailable: "Couldn't load the saved conversation, so new messages won't be saved in this session.",
        saveFailed: "Couldn't save the conversation"
    },
    markdown: {
        image: 'Image',
        imageTitle: 'Images are not loaded automatically. Open {url}'
    },
    code: {
        run: 'Run',
        runTitle: 'Type this into the terminal of {name}',
        copy: 'Copy',
        copied: 'Copied',
        copyLabel: 'Copy code',
        reference: 'Reference only',
        referenceTitle: 'Not a shell block: copy it instead of running it',
        pending: 'Waiting for the end of the block…',
        text: 'text'
    },
    run: {
        noServer: 'Select a connection first',
        dangerTitle: 'Run a destructive command?',
        dangerMessage: 'This command {reason}. Check it before it runs on {name}:',
        runAnyway: 'Run anyway'
    },
    danger: {
        recursiveDelete: 'deletes files recursively',
        disk: 'writes to or formats a disk',
        power: 'shuts down or restarts the machine',
        forkBomb: 'can exhaust the machine (fork bomb)',
        permissions: 'changes ownership or permissions of the whole system',
        database: 'deletes database data',
        firewall: 'resets the firewall rules',
        cloudDelete: 'deletes cloud resources',
        containerData: 'deletes container data',
        processes: 'kills every process',
        scheduler: 'deletes scheduled jobs',
        remoteCode: 'downloads a script from the internet and runs it',
        backdoor: 'opens remote access or sends data off the machine',
        overwrite: 'overwrites a critical system file'
    },
    autoRun: {
        label: 'Auto-Run',
        on: 'AUTO ON',
        off: 'AUTO',
        turnOn: 'Turn Auto-Run on',
        turnOff: 'Turn Auto-Run off',
        confirmTitle: 'Enable Auto-Run?',
        confirmTarget: 'Commands will run on',
        confirmBody: 'Shell commands in the AI answers will be typed into this server\'s terminal automatically. Their output goes back to the AI, which can run the next commands, up to {steps} steps in a row.',
        confirmWarning: 'Destructive commands still need your approval, but keep an eye on what runs. Auto-Run turns off when you switch servers or close the chat.',
        enable: 'Enable Auto-Run',
        running: 'Auto-Run · step {step} of {max} · waiting for the output…',
        analyzing: 'Auto-Run · step {step} of {max} · analyzing the output…',
        stop: 'Stop',
        stopLabel: 'Stop Auto-Run',
        dangerTitle: 'Auto-Run paused before a destructive command',
        dangerBody: 'The next command {reason}. Run it on {name}?',
        approve: 'Run it',
        skip: 'Skip'
    },
    notices: {
        autoRunEnabled: 'Auto-Run is on for {name}.',
        autoRunDisabled: 'Auto-Run is off.',
        autoRunClosed: 'Auto-Run turned off: the chat was closed.',
        autoRunSwitched: 'Auto-Run turned off: another server was selected.',
        autoRunPaused: 'Auto-Run paused after {steps} automatic steps. Send a message to continue, or run the commands yourself.',
        autoRunStillRunning: 'Auto-Run paused: the last command had not finished after {seconds} s. Check the terminal, then send a message to continue.',
        autoRunNotConnected: 'Auto-Run stopped: the terminal is not connected.',
        autoRunNoOutput: 'Auto-Run stopped: the terminal showed nothing after the command was sent.',
        autoRunSessionChanged: 'Auto-Run stopped: another terminal tab was selected while the command ran. Check its tab, then send a message to continue.',
        autoRunSkipped: 'Destructive command skipped. Auto-Run stopped.',
        autoRunStopped: 'Auto-Run stopped.',
        autoRunFullScreen: 'Auto-Run stopped: a full-screen program (vi, less, top…) holds the terminal, so the step was not typed.',
        autoRunNoPrompt: 'Auto-Run stopped: the terminal shows no shell prompt, so the step was not typed.',
        autoRunNotTyped: 'Auto-Run stopped: the terminal session ended before the step was typed.',
        autoRunContainer: 'Auto-Run stopped: the selected terminal tab is a shell inside a container, and Auto-Run only types into the server’s own shell. Select a tab of the server, then send a message to continue.',
        modelSwitched: 'Switched to {model}: {previous} is not available right now.',
        diagnoseNotAutoRun: 'Auto-Run never runs the fix of a diagnosis: read it, then press Run if you agree.',
        evidenceRecollected: 'That evidence was too old, or was collected before ShellMind restarted. It is being collected again: check it, then send your question again.'
    },
    // The evidence of a diagnosis ("Ask AI" buttons, the triage pack).
    evidence: {
        kinds: {
            service: 'Service {name}',
            container: 'Container {name}',
            logs: 'Logs of {name}',
            journal: 'System journal',
            selection: 'Selected lines of {name}',
            journalSelection: 'Selected lines of the system journal',
            status: 'Server status',
            triage: 'Triage pack'
        },
        sections: {
            service: 'Service status',
            journal: 'Service journal (last 200 lines)',
            events: 'Service Control Manager events',
            container: 'Container state',
            'container-logs': 'Container logs (last 200 lines)',
            logs: 'Last 200 lines',
            excerpt: 'Selected lines',
            snapshot: 'Status snapshot',
            system: 'System',
            'failed-units': 'Failed units',
            'stopped-services': 'Automatic services not running',
            errors: 'Errors of the last hour',
            kernel: 'Kernel errors and OOM kills',
            disk: 'Disk space',
            memory: 'Memory',
            processes: 'Busiest processes',
            ports: 'Listening ports',
            connection: 'Connection to the server',
            fleet: 'Last fleet health reading'
        },
        attachmentLabel: 'Attachment: {name}',
        partsLabel: 'Parts of the evidence',
        summary: '{count} parts, {size}',
        summaryOne: '1 part, {size}',
        collecting: 'Collecting the evidence from {name}…',
        readyHint: 'sent exactly as shown',
        collectFailed: "Couldn't collect the evidence:",
        review: 'Review',
        hide: 'Hide',
        retry: 'Retry',
        remove: 'Remove attachment',
        failed: 'not readable',
        unreachable: 'no connection',
        // A part read before the evidence (the fleet board's stored reading).
        readAt: 'read {time}',
        shortened: 'shortened',
        source: 'Command',
        sentLabel: 'Sent with this question',
        sentHint: 'Collected {time}. This is exactly what the AI received.',
        waiting: 'Wait until the evidence is collected',
        blocked: 'Retry or remove the attachment first',
        announceReady: 'Evidence for {name} collected ({size}). Review it, then send.',
        announceFailed: "Couldn't collect the evidence for {name}.",
        // After collectFailed.
        errors: {
            unavailable: 'nothing could be read from the server.',
            invalid: 'the request is not valid.',
            malformed: 'the answer of the backend is not valid.'
        },
        // Who the commands of a fix run as (also told to the AI).
        access: {
            label: 'Commands run as {user} ({rights}).',
            root: 'root',
            sudo: 'not root, sudo without a password',
            noSudo: 'not root, no sudo without a password',
            admin: 'administrator',
            notAdmin: 'not an administrator',
            unknown: 'rights not known'
        }
    },
    // Ask AI and Triage in the Status header, and the triage action.
    diagnose: {
        groupLabel: 'AI help',
        askLabel: 'Ask AI about this status',
        askHint: 'The snapshot, the failed units and the busiest processes go with the question.',
        triage: 'Triage',
        triageAction: 'Triage this server with AI',
        triageHint: 'Collect a triage pack (failed units, errors of the last hour, disk, memory, processes, listening ports) and ask the AI to rank the problems.'
    },
    errors: {
        generic: 'The AI could not answer.',
        withDetail: 'The AI could not answer: {detail}',
        streamEnded: 'The answer stream ended unexpectedly.',
        keyMissing: 'This model needs a {provider} API key. Add it in Settings, or choose a MiniMax model.',
        keyUnreadable: 'The saved {provider} API key cannot be decrypted (the database was moved without its data key). Enter the key again in Settings, or choose a MiniMax model.',
        provider: 'The AI provider returned an error: {detail}',
        invalidRequest: 'The request could not be processed. Try a shorter message, or clear the conversation.',
        evidenceExpired: 'The evidence expired. Collect it again.',
        network: 'Could not reach the ShellMind backend. Check that it is running and try again.'
    },
    issues: {
        title: 'Last terminal issue',
        expand: 'Show details',
        collapse: 'Hide details',
        recent: 'Recent issues',
        dismiss: 'Dismiss',
        clearAll: 'Clear all',
        analyze: 'Analyze',
        analyzeTitle: 'Ask the AI to analyze this error',
        analyzePrompt: 'Analyze the latest terminal error and tell me how to fix it.',
        fix: 'Fix it',
        fixTitle: 'Ask the AI for the exact command that fixes it',
        fixing: 'Generating a fix…',
        cancel: 'Cancel',
        suggested: 'Suggested command',
        explanation: 'No single command fixes this:',
        failed: "Couldn't get a fix: {message}",
        retry: 'Try again',
        copy: 'Copy',
        copied: 'Copied',
        run: 'Run'
    },
    provider: {
        proxy: 'MiniMax requests go through the ShellMind proxy, as described in the {legal}. Your messages, the conversation history, recent terminal and command output, the evidence you attach (service status, logs, the status snapshot…), and the server\'s name and OS details are sent there; known secret formats are masked first.',
        direct: 'MiniMax models answer directly from MiniMax with your API key. Your messages, the conversation history, recent terminal and command output, the evidence you attach (service status, logs, the status snapshot…), and the server\'s name and OS details are sent there; known secret formats are masked first. If MiniMax rejects your key, requests go through the ShellMind proxy instead, as described in the {legal}.',
        legalLink: 'legal notice',
        ack: 'Got it'
    }
};
