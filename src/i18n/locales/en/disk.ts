// W8-T4 disk-full toolkit.
export default {
    action: 'Disk usage and cleanup…',
    title: 'Disk usage',
    loadFailed: 'Could not read the filesystems of {name}.',
    refreshFailed: 'Could not read the filesystems again: the figures shown are from before.',
    loading: 'Reading the filesystems…',
    mountPicker: 'Filesystem',
    mountOption: '{mount} · {percent} used',
    freed: '{size} freed on {mount}.',
    // The toolkit's own API error codes (src/features/ops/errors.ts).
    errors: {
        DISK_UNKNOWN_MOUNT: 'That is not on a local filesystem of this server.',
        DISK_NOTHING_TO_CLEAN: 'There is nothing to clean up right now.'
    },
    entry: {
        explore: 'Explore {mount}',
        freeUp: 'Free up space',
        freeUpOn: 'Free up space on {mount}'
    },
    ai: {
        ask: 'Why is this disk full?',
        hint: 'The usage of the filesystems, the largest folders and files, deleted files still held open and what the cleanups would free go with the question.',
        prompt: 'Why is {mount} so full, and what can I safely remove or move to free space?',
        attachment: 'Disk {mount}',
        sections: {
            'disk-dirs': 'Largest directories',
            'disk-files': 'Largest files',
            'disk-deleted': 'Deleted files still open',
            'disk-consumers': 'Known consumers and cleanups'
        }
    },
    access: {
        root: 'root',
        sudo: 'sudo -n',
        admin: 'Administrator',
        elevatedHint: 'The scans read everything and the cleanups can run: the commands run as root (logged in as {user}).',
        limited: 'Limited: {user}',
        limitedHint: 'Log in as root, or as a user that may run sudo without a password, to read every folder and to clean up.',
        limitedHintWindows: 'Log in as an administrator to read every folder and to clean up.'
    },
    summary: {
        label: 'Usage of {mount}',
        used: '{used} of {total} used',
        free: '{size} free',
        freeShort: '{size} free',
        refresh: 'Read the filesystems again',
        meter: 'Space used on {mount}',
        readOnly: 'read-only',
        inodes: 'Inodes',
        inodesMeter: 'Inodes used on {mount}',
        inodesText: '{percent} used, {free} free',
        inodesFree: '{free} free',
        noInodes: 'No fixed inode table on this filesystem.'
    },
    tabs: {
        label: 'Disk views',
        usage: 'Usage',
        files: 'Largest files',
        deleted: 'Deleted but open',
        cleanup: 'Clean up'
    },
    usage: {
        up: 'Up one level',
        atTop: 'This is the top of the filesystem.',
        breadcrumb: 'Folder',
        scanned: 'Scanned {ago}',
        scannedCached: 'Scanned {ago} (kept)',
        cachedHint: 'A scan kept by ShellMind for a few minutes. Rescan to measure again.',
        rescan: 'Rescan',
        failed: 'Could not scan {path}.',
        scanning: 'Measuring {path} (it stops after {seconds} s at the latest)…',
        empty: 'This folder is empty.',
        columns: {
            name: 'Name',
            size: 'Size',
            share: 'Share'
        },
        listLabel: 'Contents of {path}, largest first',
        omitted: 'And {count} smaller items ({size}).',
        count: '{count} items',
        countOne: '1 item',
        total: 'Total {size}',
        totalPartial: 'At least {size} (the scan did not finish)',
        timedOut: 'The scan stopped after {seconds} s: the sizes listed are complete, the rest was not measured. Open a folder to narrow it down.',
        longer: 'Scan for up to {minutes} min',
        denied: '{count} folders could not be read, so these sizes are too low.',
        deniedOne: '1 folder could not be read, so these sizes are too low.',
        notMeasured: 'not measured',
        otherFs: 'other filesystem',
        notFollowed: 'link, not followed',
        partial: 'counted in part',
        open: '{item} (open)',
        openMount: 'Explore the filesystem mounted at {mount}',
        gap: 'The files here add up to {found}, but the filesystem reports {used} used: {gap} are not in any file you can see. Usually they are held by deleted files still open by a process, or hidden under a mount point.',
        gapWindows: 'The folders here add up to {found}, but the drive reports {used} used: {gap} are not counted. Usually they are system files the scan cannot read (shadow copies in System Volume Information, the paging and hibernation files).',
        gapAction: 'Check deleted files'
    },
    files: {
        threshold: 'Larger than',
        searched: 'Searched {ago}',
        searchedCached: 'Searched {ago} (kept)',
        rescan: 'Search again',
        failed: 'Could not search for large files.',
        searching: 'Searching {mount} for files over {size} (up to 90 s)…',
        timedOut: 'The search stopped at its time limit: there may be more large files.',
        none: 'No file over {size} on {mount}.',
        caption: 'Files over {size} on {mount}, largest first',
        columns: {
            size: 'Size',
            file: 'File',
            modified: 'Modified',
            owner: 'Owner',
            actions: 'Actions'
        },
        reveal: 'Show the folder of {path} in Usage'
    },
    deleted: {
        intro: 'Files deleted while a program still has them open keep taking space until the program closes them. Logs rotated or removed under a running service are the usual case.',
        check: 'Check again',
        limited: 'Only the processes of the login user could be checked.',
        loadFailed: 'Could not check for deleted files that are still open.',
        checking: 'Checking the open files on {mount}…',
        none: 'No deleted file is holding space on {mount}.',
        // Without elevation only the login user's processes were checked.
        noneOwn: 'No deleted file is held open by the processes of {user} on {mount}.',
        noneOwnDetail: 'The processes of other users could not be checked.',
        source: {
            lsof: 'Found with lsof +L1.',
            proc: 'Found in /proc (lsof is not installed).'
        },
        summary: 'held by {count} deleted files still open on {mount}',
        summaryOne: 'held by 1 deleted file still open on {mount}',
        caption: 'Deleted files still open on {mount}',
        columns: {
            size: 'Size',
            file: 'File',
            process: 'Process',
            runsIn: 'Runs in',
            actions: 'Actions'
        },
        deletedTag: '(deleted)',
        pid: 'pid {pid} · fd {fd}',
        noOwner: 'no service',
        needsRoot: 'needs root',
        busy: 'another action is running',
        actionsFor: 'Free the space of {path}',
        actions: {
            restartService: 'Restart {unit}',
            restartContainer: 'Restart container {container}',
            truncate: 'Empty the file now (truncate)',
            terminate: 'Stop {process} (SIGTERM)'
        },
        confirm: {
            'restart-service': {
                title: 'Restart {unit}?',
                message: '{unit} stops and starts again: it is unavailable for a moment. Once it has closed {path}, its {size} come back.',
                confirm: 'Restart {unit}'
            },
            'restart-container': {
                title: 'Restart container {container}?',
                message: 'The container stops and starts again, and {process} with it. Once {path} is closed, its {size} come back.',
                confirm: 'Restart the container'
            },
            truncate: {
                title: 'Empty {path}?',
                message: 'The content of the deleted file is lost and its {size} come back now. {process} (pid {pid}) keeps running and may keep writing to it.',
                confirm: 'Empty the file'
            },
            terminate: {
                title: 'Stop {process}?',
                message: '{process} (pid {pid}) gets SIGTERM and should stop. Nothing starts it again unless a service manager does. Its {size} come back once it has exited.',
                confirm: 'Stop the process'
            }
        },
        done: {
            'restart-service': '{unit} restarted.',
            'restart-container': 'Container {container} restarted.',
            truncate: 'The deleted file of {process} was emptied.',
            terminate: '{process} was asked to stop.'
        },
        failed: 'Could not free the space of that file.'
    },
    cleanup: {
        intro: 'Measuring what the known cleanups would free…',
        summary: 'About {size} could be freed on {mount}.',
        summaryLocked: 'The cleanups need root or passwordless sudo: the sizes shown are what they would free.',
        summaryLockedWindows: 'The cleanups need an administrator: the sizes shown are what they would free.',
        summaryNone: 'None of the known cleanups would free space on {mount} right now: see Usage and Largest files for what fills it.',
        measure: 'Measure again',
        measuring: 'Measuring the journal, the caches, old logs and temporary files…',
        loadFailed: 'Could not measure the cleanups.',
        noneKnown: 'No known cleanup applies to this server.',
        listLabel: 'Cleanups',
        nothing: 'Nothing to clean',
        needsAnalysis: 'Needs an analysis',
        unavailable: 'Unavailable',
        count: '{count} items',
        countOne: '1 item',
        estimateShort: {
            exact: 'reported by the tool',
            about: 'measured now',
            'up-to': 'at most',
            'at-least': 'at least'
        },
        estimate: {
            exact: '{size} freed',
            about: 'about {size}',
            'up-to': 'up to {size}',
            'at-least': 'at least {size}',
            unknown: 'size not known'
        },
        frees: 'Frees space on {mounts}',
        freesElsewhere: 'On {mounts} (another filesystem)',
        review: 'Review…',
        analyze: 'Analyze…',
        reason: {
            NOT_ELEVATED: 'Needs root or passwordless sudo.',
            NOT_ELEVATED_WINDOWS: 'Needs an administrator.',
            NOT_FOUND: 'Not on this server.',
            NO_ENGINE: 'The container engine did not answer.'
        },
        params: {
            keep: 'keep {size}',
            keepBoth: 'keep {size} and {days} days',
            older: 'older than {days} days',
            olderOne: 'older than 1 day',
            allAges: 'of any age',
            noAgeLimit: 'no age limit',
            days: '{days} days',
            daysOne: '1 day'
        },
        paramLabels: {
            days: 'Only files older than',
            keepMB: 'Keep at most',
            keepDays: 'And nothing older than'
        },
        checking: 'Checking what would be removed…',
        analyzing: 'Analyzing the component store: DISM can take several minutes (more than ten on some servers)…',
        nothingNow: 'Nothing to remove with these settings.',
        removes: 'Removes {count} items',
        removesOne: 'Removes 1 item',
        on: 'on {mounts}',
        journalUsage: 'The journal takes {size} now.',
        dismRecommended: 'DISM recommends a component store cleanup.',
        dismNotRecommended: 'DISM does not recommend a cleanup now.',
        removedByPath: 'The find of this server has no -delete: each file goes to rm by its full path.',
        itemsLabel: 'What goes, largest first',
        moreItems: 'And {count} more.',
        command: 'Runs on the server',
        confirm: 'Clean up',
        confirmSize: 'Clean up · {size}',
        done: '{name}: done.',
        failed: '{name} failed.',
        resultTitle: '{name}: done',
        close: 'Close',
        freedLabel: 'freed, measured on the server before and after',
        freedUnknown: 'The free space could not be measured afterwards.',
        reported: 'The tool reported {size}',
        mountsCaption: 'Free space before and after',
        columns: {
            mount: 'Filesystem',
            before: 'Before',
            after: 'After'
        },
        free: '{size} free',
        output: 'Command and output',
        noOutput: '(no output)',
        items: {
            journal: {
                title: 'Systemd journal',
                desc: 'Archived journal files, oldest first (journalctl --vacuum).',
                explain: 'journalctl removes archived journal files, oldest first, until the journal fits in the size you keep, and those older than the age you keep. The active journal is never removed.',
                note: 'Logs older than what you keep are gone for good: export what you still need first.'
            },
            'package-cache': {
                title: 'Package cache',
                desc: 'Downloaded packages the package manager keeps (apt, dnf, yum, apk, zypper).',
                explain: 'The package manager deletes the packages it downloaded for past installs and updates. Installed software is not touched; a later install downloads what it needs again.',
                note: 'Safe at any time; the next update downloads its packages again.'
            },
            'rotated-logs': {
                title: 'Old rotated logs',
                desc: 'Compressed and numbered logs in /var/log (*.gz, *.1, *-YYYYMMDD).',
                explain: 'Deletes the logs that logrotate (or a service) already rotated away, older than the age you choose. Current log files and the journal are kept.',
                note: 'Check that no audit or retention policy requires keeping these logs.'
            },
            tmp: {
                title: 'Old temporary files',
                desc: 'Files in /tmp and /var/tmp nobody read or changed for days.',
                explain: 'Deletes files in /tmp and /var/tmp that were not read, written or changed in the days you choose. The private temporary folders of services (systemd-private-*) and X11 sockets are kept.',
                note: 'A program that keeps a file open there for that long would lose it: choose a long enough age.'
            },
            'core-dumps': {
                title: 'Core dumps',
                desc: 'Memory dumps of crashed programs (systemd-coredump, apport, /var/crash).',
                explain: 'Deletes the core dumps crashed programs left behind. They are only useful to debug a crash.',
                note: 'Keep a dump you still need to analyze: copy it elsewhere first.'
            },
            'docker-dangling': {
                title: 'Dangling images',
                desc: 'Untagged images nothing builds on (docker image prune).',
                explain: 'The container engine removes the images that have no tag and that no other image builds on: leftovers of rebuilds and pulls.',
                note: 'Images used by a container, running or stopped, are kept.'
            },
            'docker-unused': {
                title: 'Unused images',
                desc: 'Every image no container uses (docker image prune -a).',
                explain: 'The container engine removes every image no container uses, tagged or not. The next run of one of them has to pull it again.',
                note: 'Stopped containers keep their images: remove them first to free those.'
            },
            'docker-build-cache': {
                title: 'Build cache',
                desc: 'Layers the builder keeps to speed up builds (docker builder prune).',
                explain: 'Docker removes the build cache no build and no image uses. The next build of an image may take longer.',
                note: 'Only Docker has a build cache to prune.'
            },
            'docker-containers': {
                title: 'Stopped containers',
                desc: 'Containers that exited and their writable layers (docker container prune).',
                explain: 'The container engine removes every container that is not running, with its writable layer and logs. Volumes are kept.',
                note: 'A stopped container you meant to start again is gone, its volumes stay.'
            },
            'win-temp': {
                title: 'Temporary files',
                desc: 'Your %TEMP% folder and C:\\Windows\\Temp.',
                explain: 'Deletes the files in the login user\'s temporary folder and in C:\\Windows\\Temp older than the age you choose. Files in use are skipped.',
                note: 'Setup programs sometimes keep files there while they run: avoid a cleanup during an installation.'
            },
            'win-update-cache': {
                title: 'Windows Update cache',
                desc: 'Downloaded updates (C:\\Windows\\SoftwareDistribution\\Download).',
                explain: 'Stops the Windows Update and BITS services, deletes the downloaded update files and starts the services again. Installed updates are not affected.',
                note: 'Pending downloads restart from the beginning.'
            },
            'win-recycle-bin': {
                title: 'Recycle bins',
                desc: 'Deleted files kept in the recycle bin of every drive.',
                explain: 'Empties the recycle bins of every fixed drive, for every user.',
                note: 'Files in the recycle bins cannot be restored afterwards.'
            },
            'win-component-store': {
                title: 'Component store (WinSxS)',
                desc: 'Superseded Windows components (DISM /StartComponentCleanup).',
                explain: 'For this preview DISM analyzes the component store; the cleanup then removes the components that newer updates replaced, without analyzing again. It can take a long while (half an hour or more on some servers); the server stays usable meanwhile.',
                note: 'Updates installed before the cleanup can no longer be uninstalled.'
            }
        }
    }
};
