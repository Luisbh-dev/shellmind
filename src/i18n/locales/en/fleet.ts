export default {
    title: 'Fleet health',
    description: {
        on: '{count} SSH servers, checked every {interval}',
        onOne: '1 SSH server, checked every {interval}',
        reach: '{count} SSH servers · reachability every {interval} · health checks off',
        reachOne: '1 SSH server · reachability every {interval} · health checks off',
        off: '{count} SSH servers · automatic checks off',
        offOne: '1 SSH server · automatic checks off'
    },
    interval: {
        minutes: '{count} min',
        hour: '1 hour'
    },
    state: {
        ok: 'Healthy',
        warn: 'Warning',
        critical: 'Critical',
        unreachable: 'Unreachable',
        error: 'Check failed',
        unknown: 'Unknown',
        up: 'Reachable',
        upRdp: 'RDP only',
        unchecked: 'Not checked',
        checking: 'Checking…'
    },
    tone: {
        warn: 'warning',
        critical: 'critical'
    },
    filters: {
        all: 'All',
        attention: 'Needs attention',
        search: 'Filter servers',
        searchPlaceholder: 'Name, address, group or tag',
        reboot: 'Reboot pending',
        security: 'Security updates',
        groupBy: 'Group by',
        groupNone: 'No grouping',
        groupGroup: 'Group',
        groupTag: 'Tag',
        clear: 'Clear filters'
    },
    groups: {
        none: 'No group',
        untagged: 'No tag',
        count: '{count} servers',
        countOne: '1 server'
    },
    columns: {
        state: 'State',
        server: 'Server',
        cpu: 'CPU / load',
        cpuHint: 'Windows: processor load. Linux: one-minute load average per core (1 means every core is busy).',
        memory: 'Memory',
        disk: 'Fullest disk',
        failed: 'Failed units',
        failedHint: 'systemd units in the failed state',
        reboot: 'Reboot',
        updates: 'Updates',
        updatesHint: 'Pending upgrades as the package cache knows them; the check never refreshes it.',
        uptime: 'Uptime',
        lastSeen: 'Last seen',
        actions: 'Actions',
        sort: 'Sort by {column}'
    },
    values: {
        perCore: '{value}/core',
        loadHint: 'Load {one} · {five} · {fifteen} on {cores} cores',
        diskHint: '{free} free of {total}',
        memoryHint: '{available} available of {total}',
        rebootPending: 'Pending',
        rebootNotNeeded: 'Not needed',
        unknown: 'Not reported',
        updatesNone: 'Up to date',
        updatesSecurity: '{count} security',
        updatesFrom: '{manager} cache from {when}',
        updatesManager: '{manager} cache',
        never: 'Never',
        seenAt: 'Last seen {when}',
        checkedAt: 'Last checked {when}',
        nextCheck: 'Next check {when}',
        latency: 'SSH connect {value} ms',
        bootedAt: 'Booted {when}',
        readAt: 'Health read {when}',
        sshSeenAt: 'SSH last answered {when}',
        sshNever: 'SSH has never answered',
        updatesCount: '{count} updates',
        updatesCountOne: '1 update'
    },
    errors: {
        EXEC_TIMEOUT: 'The check did not finish in time: the server may be overloaded.',
        CHECK_TIMEOUT: 'The check did not finish in time: the server may be overloaded.',
        STATUS_UNAVAILABLE: 'The server answered, but its report could not be read.',
        SSH_CHANNEL_REFUSED: 'The server refused another SSH session (its MaxSessions limit is reached).',
        NOT_SSH: 'Something answers on the SSH port, but it is not an SSH server.',
        viaJump: 'Jump host {name}: {reason}'
    },
    notes: {
        auth: 'Credentials rejected. Automatic checks stopped so the account is not locked out: fix the connection, then check again.',
        hostKey: 'Host key changed. Automatic checks stopped: open the terminal to compare the keys and trust the new one.',
        config: 'The saved connection cannot be used as it is. Automatic checks stopped until it is fixed.',
        excluded: 'Left out of automatic checks',
        unreachableSince: 'Last seen {when}',
        neverReached: 'Never reached',
        up: 'Its SSH server answers (checked without logging in). Check it now to read its health.',
        rdpOnly: 'Only its Remote Desktop port answers: its SSH port does not, so the terminal, Status, multi-exec and health checks cannot reach it.',
        sshStopped: 'Only its Remote Desktop port answers: its SSH server answered {when}, but not now. The terminal, Status, multi-exec and health checks need it.',
        behindJump: 'Behind a jump host: only health checks, which log in, reach it.'
    },
    blocked: {
        jumpAuth: 'Waiting for jump host {name}: its credentials were rejected. Fix them to check this server.',
        jumpHostKey: 'Waiting for jump host {name}: its host key changed. Trust the new key to check this server.',
        jumpConfig: 'Waiting for jump host {name}: its saved connection cannot be used as it is.',
        login: 'Paused: the login "{user}" was just rejected on {count} servers in a row, so its other servers wait to keep the account from being locked. Check this one now to try it.',
        identity: 'Paused: its saved identity was just rejected on {count} servers in a row, so its other servers wait to keep the account from being locked. Check this one now to try it.'
    },
    actions: {
        checkAll: 'Check all now',
        checkAllHint: 'A health check of every monitored server, except those whose checks are on hold or waiting',
        checkNow: 'Check {name} now',
        checkJump: 'Check jump host {name} now',
        fix: 'Fix the connection of {name}',
        fixJump: 'Fix the connection of jump host {name}',
        compareKeys: 'Compare the host keys of {name}',
        askAiHeld: 'Fix the connection first: opening the server logs in with the rejected credentials again.',
        more: 'More actions for {name}',
        openStatus: 'Open status',
        openTerminal: 'Open terminal',
        openOperations: 'Open operations',
        edit: 'Edit connection',
        exclude: 'Leave out of automatic checks',
        include: 'Include in automatic checks',
        settings: 'Monitoring settings',
        open: 'Open {name}'
    },
    askAi: {
        prompt: '{name} is "{state}" on the fleet board ({details}). What is going on and what should I check first?',
        promptPlain: '{name} is "{state}" on the fleet board. What is going on and what should I check first?'
    },
    off: {
        title: 'Automatic checks are off',
        text: 'Turn them on to check every SSH server every {interval} with a short read-only script over its saved connection. The checks show up in the servers\' auth logs, and rejected credentials are never retried on their own.',
        enable: 'Turn on',
        checkOnce: 'Check all once',
        reachTitle: 'Only reachability is checked',
        reachText: 'ShellMind checks that each server answers, without logging in. Turn on health checks to read CPU, memory, disks, failed units and updates every {interval}: they log in over each server\'s saved connection, so they show up in its auth logs. Rejected credentials are never retried on their own.',
        enableHealth: 'Turn on health checks'
    },
    empty: {
        noServers: 'No SSH servers yet',
        noServersText: 'Linux and Windows servers you add appear here with their health.',
        noMatch: 'No servers match these filters.',
        allGood: 'Nothing needs attention',
        allGoodText: 'Every server that was checked is within its limits.'
    },
    summary: {
        label: 'Servers by state'
    },
    feed: {
        offline: 'Live updates paused, reconnecting…',
        loading: 'Loading the fleet…'
    },
    toasts: {
        refreshFailed: 'Could not start the checks',
        nothingToCheck: 'No servers to check',
        saveFailed: 'Could not save the fleet settings',
        jumpHost: 'Check the jump host first',
        jumpHostText: '{name} waits for its jump host, whose checks are on hold.'
    },
    settings: {
        heading: 'Fleet health',
        loadFailed: 'Could not load the fleet settings.',
        reachability: 'Check that servers answer, without logging in',
        reachabilityHint: 'Connects to the SSH port of each server reached directly and reads its greeting, every {interval} at most often. When the SSH port of a Windows server does not answer, its Remote Desktop port answering counts too, and the board says that only Remote Desktop answers. No login, so it never reaches the auth logs; servers behind a jump host are left out.',
        reachabilityCovered: 'Health checks already tell whether each server answers.',
        enabled: 'Check their health in the background (logs in)',
        enabledHint: 'A short read-only script runs on each Linux and Windows server over its saved SSH connection, a few servers at a time. It appears in their auth logs; rejected credentials and changed host keys are never retried on their own, and a login rejected on several servers in a row is not tried on the others.',
        interval: 'Check every',
        notifications: 'Notify me when a server turns critical or unreachable',
        notificationsHint: 'A desktop notification while ShellMind is in the background, a message in the app while it is in front. Each server notifies at most once every 30 minutes.',
        notificationsDenied: 'Notifications are blocked for this page in the browser settings.',
        notificationsAllow: 'Allow desktop notifications',
        excluded: '{count} servers are left out of automatic checks.',
        excludedOne: '1 server is left out of automatic checks.',
        includeAll: 'Include them again',
        note: 'Checks run while ShellMind is running and keep the latest result of each server. This is triage, not a monitoring system.'
    },
    alerts: {
        critical: '{name} is critical',
        unreachable: '{name} is unreachable',
        many: '{count} servers need attention',
        reasonUnreachable: 'No SSH connection: {reason}'
    },
    sidebar: {
        health: 'Health: {state}',
        checked: 'checked {when}'
    }
};
