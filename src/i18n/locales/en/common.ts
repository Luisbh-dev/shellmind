export default {
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    dismiss: 'Dismiss',
    select: 'Select…',
    areYouSure: 'Are you sure?',
    loading: 'Loading…',
    loadFailed: 'This window could not be opened',
    retry: 'Try again',
    // Keys named by words, as keyboards label them (shortcuts).
    keys: {
        shift: 'Shift',
        delete: 'Delete',
        insert: 'Insert',
        enter: 'Enter',
        escape: 'Esc',
        backspace: 'Backspace',
        space: 'Space',
        tab: 'Tab'
    },
    status: {
        idle: 'Idle',
        connecting: 'Connecting',
        connected: 'Connected',
        disconnected: 'Disconnected',
        error: 'Error'
    },
    errors: {
        backendUnreachable: 'Could not reach the ShellMind backend.',
        invalidResponse: 'The server returned an invalid response.'
    },
    // AskAiButton: the chat starts from a question about the thing it is next to.
    askAi: {
        label: 'Ask AI',
        about: 'Ask AI about {name}',
        selectionHint: 'Select some lines first to ask about those lines only.',
        prompts: {
            service: 'What is wrong with the service {name}, and how do I fix it?',
            container: 'What is wrong with the container {name}, and how do I fix it?',
            logs: 'What do the logs of {name} say is wrong, and how do I fix it?',
            journal: 'What does the system journal say is wrong, and how do I fix it?',
            selection: 'What do these log lines say is wrong, and how do I fix it?',
            status: 'Is anything wrong with this server, and what should I do about it?',
            triage: 'Check this server for problems: failed services, recent errors, disk, memory and the busiest processes.'
        }
    }
};
