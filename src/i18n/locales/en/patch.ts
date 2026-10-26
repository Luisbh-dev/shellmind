export default {
    title: 'Patch center',
    action: 'Patch center',
    serverAction: 'Updates of this server (patch center)',
    description: {
        servers: '{count} SSH servers',
        serversOne: '1 SSH server',
        pending: '{count} pending updates',
        pendingOne: '1 pending update',
        security: '{count} security',
        reboot: '{count} need a reboot',
        rebootOne: '1 needs a reboot'
    },
    view: 'Updates',
    filters: {
        label: 'Show',
        all: 'All',
        security: 'Security updates',
        updates: 'Pending updates',
        reboot: 'Reboot pending',
        attention: 'Needs attention',
        unscanned: 'Not scanned',
        search: 'Filter servers',
        searchPlaceholder: 'Name, address, group, tag or manager',
        clear: 'Clear filters'
    },
    columns: {
        select: 'Select',
        selectAll: 'Select every server shown',
        server: 'Server',
        manager: 'Manager',
        pending: 'Pending',
        security: 'Security',
        reboot: 'Reboot',
        lastUpdate: 'Last update',
        lists: 'Package lists',
        status: 'Status'
    },
    managers: {
        apt: 'apt',
        dnf: 'dnf',
        yum: 'yum',
        zypper: 'zypper',
        apk: 'apk',
        pacman: 'pacman',
        'windows-update': 'Windows Update'
    },
    values: {
        unknown: 'Unknown',
        estimated: 'From the last Fleet health check (not a scan): scan the server for its list.',
        noSecurityInfo: 'This package manager does not say which updates fix security problems.',
        rebootRequired: 'Required',
        rebootNo: 'No',
        never: 'Never',
        stale: 'These package lists are more than a week old: refresh them for the current updates.',
        listsMissing: 'Never downloaded'
    },
    status: {
        scanning: 'Scanning…',
        running: 'Patching',
        notScanned: 'Not scanned',
        upToDate: 'Up to date',
        sudoPassword: 'sudo asks for a password',
        noPrivilege: 'Needs root or sudo',
        listOnly: 'Listed only'
    },
    actions: {
        scanAll: 'Scan all',
        scanSelected: 'Scan selected ({count})',
        scanHint: 'Reads each server’s pending updates from its package cache (read-only, nothing is installed or refreshed). Servers whose login was refused are left out until you scan them on their own.',
        patchSelected: 'Patch selected ({count})',
        patchSelectedOne: 'Patch selected (1)',
        patchNone: 'Select the servers to patch first',
        open: 'Updates of {name}',
        openRow: '{name}: updates',
        closeDetails: 'Close the updates of {name}',
        rescan: 'Scan again',
        rescanHint: 'Reads this server’s pending updates from its package cache (read-only).',
        refresh: 'Refresh package lists',
        refreshHint: 'Runs apt-get update, dnf makecache, zypper refresh, apk update or pacman -Sy as root or with sudo -n, then scans again.',
        refreshWindows: 'Search Windows Update',
        refreshWindowsHint: 'Asks Windows Update (or WSUS) for the updates now. It can take a few minutes.',
        installSecurity: 'Install security updates…',
        installAll: 'Install all updates…',
        openCenter: 'Open the patch center',
        showRun: 'Show the run',
        backToServers: 'Back to the servers',
        audit: 'Audit log'
    },
    summary: {
        windowsLists: 'Last search',
        scanned: 'Scanned {when}',
        privilege: 'Installs as'
    },
    privilege: {
        root: 'root',
        sudo: 'sudo without a password',
        'sudo-password': 'sudo asks for a password',
        none: 'no root, no sudo',
        admin: 'Administrator',
        user: 'standard user'
    },
    notes: {
        sudoPassword: 'sudo asks this user for a password. ShellMind installs updates only as root or with sudo that needs no password for any command (sudo -n); it never types a password. Give the user a sudoers rule with NOPASSWD: ALL (one limited to the package manager is not enough: a run also uses env, apt-mark, needrestart and the reboot command), or save the server with root.',
        noPrivilege: 'This user is not root and has no sudo: ShellMind can list the updates but not install them.',
        windows: 'Windows updates are listed here; ShellMind does not install them. Use Windows Update or WSUS to install them.',
        noManager: 'No supported package manager (apt, dnf, yum, zypper, apk or pacman) was found on this server.',
        jumpHost: 'Other servers are reached through this one ({names}): a patch run never reboots it.',
        noSecurity: '{manager} does not say which updates fix security problems: only “all updates” can be installed.'
    },
    notices: {
        'metadata-missing': 'The package lists were never downloaded on this server: refresh them to see its updates.',
        'manager-busy': 'Another package manager is running ({detail}): an install waits for it (up to 5 minutes for apt).',
        'security-unknown': 'The repositories carry no security information, so security updates cannot be told apart.',
        'listing-failed': 'Listing the updates failed.',
        truncated: 'Only the first 2000 of {detail} updates are listed.',
        'search-failed': 'Windows Update could not be searched.',
        'search-denied': 'Over SSH Windows Update lets only administrators search it: save this server with an administrator account to list its updates.'
    },
    updates: {
        title: 'Pending updates',
        search: 'Filter updates',
        searchPlaceholder: 'Package, repository or version',
        securityOnly: 'Security only',
        package: 'Package',
        installed: 'Installed',
        available: 'Available',
        security: 'Security',
        securityBadge: 'Security',
        newPackage: 'new',
        shown: '{shown} of {total}',
        showAll: 'Show all {count}',
        empty: 'No pending updates',
        emptyText: 'Everything the package lists know about is installed.',
        noMatch: 'No update matches the filter',
        notScanned: 'Not scanned yet',
        notScannedText: 'Scan the server to read its pending updates (read-only).',
        scanFailed: 'The scan failed',
        scanFailedDetail: 'Technical detail',
        held: 'Held back ({count})',
        heldHint: 'apt keeps these back: installing them would remove other packages (a full upgrade, done by hand), or Ubuntu is phasing them in.',
        heldReason: {
            'kept-back': 'kept back',
            phased: 'phased'
        },
        patches: 'Needed patches ({count})',
        rebootPackages: 'Asking for the reboot',
        restartServices: 'Services using outdated libraries',
        refreshOutput: 'Output of the refresh'
    },
    apply: {
        title: 'Patch {count} servers',
        titleOne: 'Patch {name}',
        mode: 'What to do',
        modes: {
            security: 'Security updates',
            securityHint: 'Only the updates the repositories mark as security fixes.',
            all: 'All updates',
            allHint: 'Every pending update (apt: like apt upgrade, never removing packages).',
            refresh: 'Refresh the package lists',
            refreshHint: 'Only download the package lists again; nothing is installed.'
        },
        refreshFirst: 'Refresh the package lists first',
        refreshFirstHint: 'Without it, servers install what their package lists know now, as the scan showed.',
        reboot: 'Reboot servers that need it, and wait for SSH to come back',
        rebootHint: 'After the updates, a server that reports a pending reboot restarts; the run waits for it to answer SSH again and checks it (uptime, systemd state, failed units). Jump hosts are never rebooted.',
        rebootWait: 'Wait for SSH up to',
        timeout: 'Time per server',
        timeoutHint: 'Updates, reboot and wait included.',
        timeoutHintReboot: 'Updates, reboot and wait included: at least {count} min with this wait for SSH.',
        minutes: '{count} min',
        review: 'Review',
        back: 'Back',
        start: 'Start patching {count} servers',
        startOne: 'Start patching {name}',
        cancel: 'Cancel'
    },
    preview: {
        loading: 'Working out what the run will do…',
        heading: 'What will happen',
        summary: '{action} on {count} of {total} servers.',
        summaryOne: '{action} on {name}.',
        actions: {
            security: 'Install security updates',
            all: 'Install all updates',
            refresh: 'Refresh the package lists'
        },
        refreshFirst: 'The package lists are refreshed first: servers may install more than counted here.',
        totals: '{pending} updates in all, {security} of them security updates, as last scanned.',
        reboots: 'Servers that report a pending reboot once their updates are in will reboot, one by one as their turn comes.',
        rebootNow: 'Already waiting for a reboot: {names}.',
        nothing: 'None of these servers can be patched now.',
        toInstall: 'To install',
        servers: 'Servers',
        willRun: 'Runs',
        skipped: 'Left out',
        rebootPlan: {
            'if-required': 'Reboots if required',
            off: 'No reboot',
            'jump-host': 'Jump host: no reboot'
        },
        commands: 'Commands',
        commandsHint: 'Run as root, or with sudo -n for other users. Every answer is given in advance (-y, non-interactive), and changed configuration files are kept.',
        script: 'Show the script every server runs',
        scanned: 'scanned {when}',
        confirmLabel: 'Type {count} to confirm patching {count} servers',
        confirmHint: 'Patching changes running servers. The run is recorded in the audit log.',
        oneConfirm: 'The run is recorded in the audit log, and you can follow, pause or cancel it.'
    },
    skip: {
        'not-found': 'Deleted',
        unsupported: 'Not an SSH server',
        windows: 'Windows: listed only',
        'not-scanned': 'Not scanned',
        'scan-failed': 'Its scan failed',
        'no-manager': 'No supported package manager',
        privilege: 'Needs root or passwordless sudo',
        'sudo-password': 'sudo asks for a password',
        'no-security': 'No security information',
        'up-to-date': 'Nothing to do',
        busy: 'Already being patched'
    },
    job: {
        title: 'Patch run',
        running: 'A patch run is going on on this server.',
        last: 'Latest patch run'
    },
    history: {
        retry: 'Patch again where it failed ({count})',
        retryHint: 'Opens the patch center on these servers: the run is planned again (preview, reboot, audit log).',
        open: 'Open in the patch center'
    },
    output: {
        seconds: '{count} s',
        minutes: '{count} min',
        minutesSeconds: '{minutes} min {seconds} s',
        manager: 'Package manager: {manager}.',
        refreshFailed: 'Refreshing the package lists failed (exit status {code}); the run goes on with the lists the server has.',
        failed: 'The package manager failed (exit status {code}).',
        noSecurityUpdates: 'No security updates are pending.',
        autoMarksFailed: 'The updated packages that had been installed as dependencies could not be marked as automatic again (exit status {code}): run apt-mark auto on them.',
        rebootRequired: {
            yes: 'A reboot is required.',
            no: 'No reboot is required.',
            unknown: 'Whether a reboot is required is not known.'
        },
        error: {
            privilege: 'This needs root or sudo without a password (sudo -n), and this user has neither: ShellMind never types a password.',
            'no-manager': 'No supported package manager (apt, dnf, yum, zypper, apk or pacman) was found.',
            'no-security': '{manager} does not say which updates fix security problems: install all updates instead.',
            'reboot-privilege': 'Rebooting needs root or sudo without a password (sudo -n).'
        },
        reboot: {
            start: 'Rebooting the server.',
            waiting: 'Waiting for SSH to come back…',
            stillWaiting: 'Still waiting for SSH ({after})…',
            back: 'Back after {after}',
            up: 'up {up}',
            state: 'system {state}',
            failedUnits: '{count} failed units',
            failedUnitsOne: '1 failed unit',
            'skip-no-boot-id': 'A reboot is required, but this server gives no way to tell one boot from the next: not rebooting it.',
            'skip-unknown': 'Not rebooting: it is not known whether a reboot is required.',
            'skip-jump-host': 'A reboot is required, but other servers are reached through this one: reboot it on its own.'
        },
        check: {
            state: 'The system is “{state}” after the reboot.',
            failedUnits: 'More systemd units failed after the reboot than before ({before} before, {after} now).',
            stillStarting: 'systemd is still starting units after {after}.'
        },
        rebootFailed: {
            command: 'The reboot command failed (exit status {code}).',
            timeout: 'The server did not answer SSH within {wait} of the reboot.',
            sameBoot: 'The server did not reboot: {after} after the reboot command it still runs the same boot.',
            connection: 'After the reboot, the server could not be reached: {detail}',
            check: 'The server came back, but checking it failed: {detail}',
            cancelled: 'Cancelled while waiting for the server to come back.'
        },
        lastAttempt: 'Last attempt: {detail}'
    },
    errors: {
        loadFailed: 'The patch center could not load its servers.',
        scanFailed: 'The servers could not be scanned.',
        previewFailed: 'The run could not be planned.',
        startFailed: 'The run could not start.',
        PATCH_PRIVILEGE: 'Refreshing the package lists needs root or sudo without a password (sudo -n).',
        PATCH_REFRESH_FAILED: 'The package manager could not refresh its lists.',
        PATCH_BUSY: 'A patch run is going on on this server: wait for it to end.',
        PATCH_CONFIRM_MISMATCH: 'The servers changed since the review ({expected} would run now): review the run again.',
        PATCH_NOTHING_TO_RUN: 'None of these servers can be patched now.',
        PATCH_UNSUPPORTED: 'The patch center only reads Linux and Windows servers (over SSH).',
        PATCH_SCAN_FAILED: 'The server’s updates could not be read.',
        MULTIEXEC_BUSY: 'Four runs are going on already: wait for one to end.'
    },
    empty: {
        noServers: 'No SSH servers yet',
        noServersText: 'Add a Linux or Windows server to see its updates here.',
        noMatch: 'No server matches the filters'
    },
    toasts: {
        started: 'Patch run started',
        startedText: '{count} servers. Follow it here or in the multi-exec jobs.',
        startedTextOne: '{name}. Follow it here or in the multi-exec jobs.',
        refreshed: 'Package lists refreshed'
    }
};
