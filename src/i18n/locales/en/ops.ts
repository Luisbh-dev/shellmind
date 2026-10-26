export default {
    tab: 'Operations',
    viewsLabel: 'Operations views',
    views: {
        services: 'Services',
        containers: 'Containers',
        compose: 'Compose',
        images: 'Images',
        logs: 'Logs'
    },
    privilege: {
        root: 'root',
        rootHint: 'Logged in as root: actions run directly.',
        admin: 'Administrator',
        adminHint: 'This user is a Windows administrator: services can be started and stopped.',
        sudo: 'sudo',
        sudoHint: 'Privileged actions run with passwordless sudo (sudo -n).',
        user: 'No admin rights',
        userHint: 'This user is not root and cannot use sudo without a password: some actions and logs may be refused.',
        windowsUserHint: 'This user is not an administrator: starting and stopping services may be refused.'
    },
    redetect: 'Check the server again',
    redetectFailed: 'Could not check the server again; the views use the previous results.',
    detecting: 'Checking what this server offers…',
    retry: 'Retry',
    clearSearch: 'Clear search',
    refresh: 'Refresh',
    back: 'Back to the list',
    loading: 'Loading…',
    errors: {
        unknown: 'Something went wrong.',
        EXEC_TIMEOUT: 'The server took too long to answer.',
        EXEC_STREAMS_BUSY: 'This connection already runs the maximum number of live streams. Stop one first.',
        EXEC_OUTPUT_TOO_LARGE: 'The command printed too much output and was stopped.',
        EXEC_ABORTED: 'The command was cancelled.',
        SSH_CHANNEL_REFUSED: 'The server refused another session (its SSH MaxSessions limit is reached). Close a terminal or file tab of this server, or raise MaxSessions.',
        SSH_FAILED: 'Could not connect to the server.',
        SSH_CLOSED: 'The connection to the server was lost.',
        HOST_KEY_MISMATCH: 'The host key of this server has changed. Check it under Known hosts before connecting again.',
        SECRET_UNREADABLE: 'The saved credentials cannot be decrypted. Enter them again in the connection settings.',
        OPS_PERMISSION_DENIED: 'The server refused the action: not enough privileges.',
        OPS_COMMAND_FAILED: 'The command failed on the server.',
        OPS_UNSUPPORTED: 'Not available on this server.',
        OPS_INVALID_INPUT: 'That name or path is not valid.',
        OPS_NOT_FOUND: 'It no longer exists on the server.',
        STATUS_UNAVAILABLE: 'The server did not return a complete report.',
        LOGS_LIMIT: 'Too many log streams are open. Stop one first.',
        SERVER_NOT_FOUND: 'This server no longer exists.',
        UNSUPPORTED_PURPOSE: 'Not available for this type of server.',
        JUMP_HOST: 'The jump host of this server cannot be used.',
        PRIVATE_KEY_FILE: 'The private key file of this server cannot be read.',
        INTERNAL: 'The backend hit an unexpected error; its log has the details.',
        COMPOSE_FILES_MISSING: 'The Compose files of this project are not on the server any more.'
    },
    services: {
        noSystemd: 'This server does not use systemd',
        noSystemdHint: 'Service management needs systemd (or a Windows server). Live logs of files and containers are still available.',
        search: 'Search services',
        filterLabel: 'Show services',
        filter: {
            all: 'All',
            running: 'Running',
            failed: 'Failed',
            stopped: 'Stopped'
        },
        empty: 'No services match.',
        limitedWindows: 'Over SSH Windows lets only administrators list the services: these are the ones this user may still query, and most of them it may not start or stop.',
        caption: '{count} services',
        columns: {
            name: 'Service',
            state: 'State',
            startup: 'Startup'
        },
        detailLabel: 'Service {name}',
        actionsLabel: 'Service actions',
        actions: {
            start: 'Start',
            stop: 'Stop',
            restart: 'Restart',
            reload: 'Reload',
            enable: 'Enable',
            disable: 'Disable'
        },
        confirm: {
            start: { title: 'Start {name}?', message: 'The service will be started on the server.' },
            stop: { title: 'Stop {name}?', message: 'The service stops now and whatever depends on it may stop working.' },
            restart: { title: 'Restart {name}?', message: 'The service stops and starts again; open connections to it are dropped.' },
            reload: { title: 'Reload {name}?', message: 'The service reloads its configuration without stopping.' },
            enable: { title: 'Enable {name}?', message: 'The service will start automatically at boot.' },
            disable: { title: 'Disable {name}?', message: 'The service will no longer start at boot. It keeps running until stopped.' },
            dependents: {
                stop: 'Running services that depend on it are stopped too: {names}.',
                restart: 'Running services that depend on it are stopped during the restart: {names}.',
                unknown: 'Services that depend on it are stopped as well.'
            }
        },
        done: {
            start: '{name} started',
            stop: '{name} stopped',
            restart: '{name} restarted',
            reload: '{name} reloaded',
            enable: '{name} enabled',
            disable: '{name} disabled'
        },
        failed: 'Could not change {name}',
        journal: {
            title: 'Journal',
            lines: 'Journal lines to show',
            follow: 'Follow live',
            hint: 'Choose how many recent lines to load, or follow the journal live.',
            empty: 'The journal has no entries for this unit.'
        }
    },
    containers: {
        noEngine: 'No container engine available',
        search: 'Search containers',
        filterLabel: 'Show containers',
        filter: {
            all: 'All',
            running: 'Running',
            stopped: 'Stopped'
        },
        stats: 'Usage',
        projects: 'Compose projects',
        empty: 'No containers match.',
        caption: '{count} containers',
        columns: {
            name: 'Container',
            state: 'State',
            ports: 'Ports',
            cpu: 'CPU',
            memory: 'Memory',
            shell: 'Shell'
        },
        // The engine's state words (Docker and Podman), as the badges show them.
        states: {
            running: 'running',
            unhealthy: 'unhealthy',
            exited: 'exited',
            stopped: 'stopped',
            created: 'created',
            configured: 'configured',
            initialized: 'initialized',
            restarting: 'restarting',
            paused: 'paused',
            removing: 'removing',
            dead: 'dead',
            unknown: 'unknown'
        },
        // The engine's status line ({duration} '9 minutes', {ago} '3 days ago').
        statusText: {
            up: 'Up {duration}',
            exited: 'Exited ({code}) {ago}',
            restarting: 'Restarting ({code}) {ago}',
            created: 'Created',
            health: {
                healthy: 'healthy',
                unhealthy: 'unhealthy',
                starting: 'health check starting',
                paused: 'paused'
            }
        },
        detailLabel: 'Container {name}',
        actionsLabel: 'Container actions',
        askAi: 'Diagnose {name} with AI',
        shell: {
            open: 'Open shell',
            openIn: 'Open a shell in {name}',
            choose: 'Choose the shell',
            with: 'Open {shell}',
            notRunning: 'Start the container to open a shell in it.',
            linuxOnly: 'Container shells are available on Linux servers.'
        },
        actions: {
            start: 'Start',
            stop: 'Stop',
            restart: 'Restart',
            remove: 'Remove'
        },
        confirm: {
            start: { title: 'Start {name}?', message: 'The container will be started.' },
            stop: { title: 'Stop {name}?', message: 'The container stops; its processes get a few seconds to exit.' },
            restart: { title: 'Restart {name}?', message: 'The container stops and starts again.' },
            remove: { title: 'Remove {name}?', message: 'The container is stopped if it is running and then deleted. Named volumes are kept. This cannot be undone.' }
        },
        done: {
            start: '{name} started',
            stop: '{name} stopped',
            restart: '{name} restarted',
            remove: '{name} removed'
        },
        failed: 'Could not change {name}',
        fields: {
            status: 'Status',
            id: 'ID',
            created: 'Created',
            started: 'Started',
            finished: 'Stopped',
            finishedValue: '{time} (exit code {code})',
            oom: 'Memory',
            oomValue: 'Killed for running out of memory (OOM)',
            error: 'Error',
            command: 'Command',
            restart: 'Restart policy',
            restartValue: '{policy} · restarted {count} times',
            restartValueOne: '{policy} · restarted once',
            user: 'User',
            workdir: 'Working directory',
            compose: 'Compose'
        },
        sections: {
            overview: 'Overview',
            health: 'Health check',
            usage: 'Usage now',
            ports: 'Ports',
            env: 'Environment',
            mounts: 'Mounts',
            networks: 'Networks'
        },
        health: {
            healthy: 'Healthy',
            starting: 'Starting',
            unhealthy: 'Unhealthy',
            unknown: 'Unknown',
            streak: 'Failed {count} checks in a row',
            streakOne: 'Failed the last check',
            exit: 'exit {code}'
        },
        usage: {
            stopped: 'The container is not running.',
            cpu: 'CPU',
            memory: 'Memory',
            pids: 'Processes',
            net: 'Network I/O',
            block: 'Disk I/O',
            measure: 'Measure again'
        },
        ports: {
            none: 'No ports are exposed.',
            notPublished: 'not published',
            to: 'to the container port'
        },
        env: {
            hint: 'Values are hidden: they often hold passwords and tokens.',
            showAll: 'Show all',
            hideAll: 'Hide all',
            show: 'Show the value of {name}',
            hide: 'Hide the value of {name}',
            copy: 'Copy the value of {name}',
            copied: 'Value of {name} copied',
            copyFailed: 'Could not copy the value',
            masked: 'hidden value',
            empty: 'No environment variables.'
        },
        mounts: {
            none: 'Nothing is mounted.',
            readOnly: 'read-only',
            readWrite: 'read-write',
            volume: 'Volume {name}'
        },
        networks: {
            none: 'Not attached to any network.',
            mode: 'Network mode: {mode}',
            ip: 'IP address',
            gateway: 'Gateway',
            aliases: 'Names'
        },
        logs: {
            title: 'Recent logs',
            lines: 'Log lines to show',
            follow: 'Follow live',
            hint: 'Choose how many recent lines to load, or follow the logs live.',
            empty: 'The container has not written any logs.'
        },
        inspect: {
            title: 'Inspect output',
            masked: 'Environment values are hidden.',
            revealed: 'Environment values are shown.',
            reveal: 'Show values',
            mask: 'Hide values'
        },
        viaSudo: 'The container engine is used through sudo -n on this server.',
        detailUnavailable: 'The details could not be read.',
        gone: 'This container is no longer listed. Refresh the list.'
    },
    compose: {
        search: 'Search projects',
        caption: '{count} Compose projects',
        columns: {
            name: 'Project',
            state: 'Containers',
            services: 'Services'
        },
        runningCount: '{running}/{total} running',
        noDirectory: 'Directory unknown',
        empty: 'No Compose projects',
        emptyHint: 'Projects appear here once docker compose up (or podman-compose up) has created their containers on this server.',
        noMatch: 'No projects match.',
        readOnly: 'Projects are shown, but actions are unavailable: {problem}',
        noTool: 'Compose is not installed on this server.',
        needsFiles: 'This needs the project’s Compose files, which the server no longer has.',
        unusableName: 'ShellMind does not run Compose for a project with this name.',
        unusableNameNotice: 'This name comes from a container label and has characters Compose project names do not use, so ShellMind does not run Compose commands for it. Manage it from a terminal.',
        detailLabel: 'Compose project {name}',
        actionsLabel: 'Project actions',
        actions: {
            up: 'Up',
            update: 'Pull & recreate',
            restart: 'Restart',
            stop: 'Stop',
            down: 'Down'
        },
        logs: 'Follow logs',
        serviceLogs: 'Follow its logs',
        serviceActions: 'Actions for {service}',
        running: '{action}: {name}…',
        runningSlow: '{action}: {name}… Pulling images can take a few minutes.',
        lastRun: {
            ok: 'Last action: {action}',
            failed: 'Last action failed: {action}',
            noOutput: 'No output.'
        },
        servicesLabel: 'Services of the project',
        servicesTitle: 'Containers · {count}',
        files: 'Compose files',
        noFiles: 'The containers do not say which files created them.',
        missing: '(missing)',
        filesMissing: 'Compose files missing on the server',
        filesMissingShort: 'Compose files missing',
        filesMissingHint: 'Up and Pull & recreate need them. Stop, Restart, Down and the logs still work by the project’s name.',
        filesMissingHintPodman: 'podman-compose needs them for every action.',
        tool: 'Runs with {tool}.',
        gone: 'This project has no containers any more (it was taken down or removed). To bring it back, run {command} in its directory.',
        failed: 'Could not change {name}',
        done: {
            up: '{name} is up',
            update: '{name} pulled and recreated',
            restart: '{name} restarted',
            stop: '{name} stopped',
            down: '{name} taken down'
        },
        confirm: {
            up: {
                title: 'Bring up {name}?',
                message: 'Creates the missing containers of {name} and recreates those whose configuration or image changed. Containers that did not change keep running.',
                serviceTitle: 'Bring up {service} of {name}?',
                service: 'Creates or recreates {service} (and starts the services it depends on) from the project’s Compose files.'
            },
            update: {
                title: 'Pull and recreate {name}?',
                message: 'Downloads newer images for {name}, then recreates the containers whose image or configuration changed. Those services restart: their open connections drop.',
                serviceTitle: 'Pull and recreate {service} of {name}?',
                service: 'Downloads a newer image for {service} and recreates its container if it changed. The service restarts.'
            },
            restart: {
                title: 'Restart {name}?',
                message: 'Every container of {name} stops and starts again; open connections to it drop.',
                serviceTitle: 'Restart {service} of {name}?',
                service: 'The containers of {service} stop and start again.'
            },
            stop: {
                title: 'Stop {name}?',
                message: 'The containers of {name} stop. They are kept: Up starts them again.',
                serviceTitle: 'Stop {service} of {name}?',
                service: 'The containers of {service} stop. Services that depend on it may stop working.'
            },
            down: {
                title: 'Take down {name}?',
                message: 'These containers of {name} are stopped and removed, with the project’s networks:',
                keep: 'Named volumes and images are kept, but files written inside the containers (outside volumes) are lost. The project then leaves this list: bring it back with {command} in its directory.'
            }
        }
    },
    images: {
        search: 'Search images',
        caption: '{count} images',
        filterLabel: 'Show images',
        filter: {
            all: 'All',
            used: 'In use',
            unused: 'Unused',
            dangling: 'Dangling'
        },
        columns: {
            image: 'Image',
            size: 'Size',
            created: 'Created',
            usage: 'Used by',
            actions: 'Actions'
        },
        untagged: 'untagged',
        dangling: 'dangling',
        unused: 'unused',
        usedBy: '{count} containers',
        usedByOne: '1 container',
        inUse: 'Used by {count} containers: remove them first.',
        inUseOne: 'Used by a container: remove it first.',
        empty: 'No images on this server.',
        noMatch: 'No images match.',
        remove: 'Remove',
        removeName: 'Remove {name}',
        removed: '{name} removed',
        removeFailed: 'Could not remove {name}',
        confirmRemove: {
            title: 'Remove {name}?',
            tagged: 'The tag {name} is removed, and the image with it unless another tag points to it. It is downloaded again the next time it is needed.',
            untagged: 'This untagged image is deleted. This cannot be undone.'
        },
        cleanUp: 'Clean up',
        usage: {
            title: 'Disk space of the container engine',
            failed: 'Could not read the disk usage.',
            images: 'Images',
            containers: 'Containers',
            volumes: 'Volumes',
            'build-cache': 'Build cache',
            reclaimable: '{size} reclaimable',
            count: '{count} in total'
        },
        prune: {
            checking: 'Checking what would be removed…',
            listLabel: 'Images that would be removed',
            count: '{count} images',
            countOne: '1 image',
            confirm: 'Remove {count} images',
            confirmOne: 'Remove 1 image',
            failed: 'The clean-up failed',
            freed: '{size} freed.',
            estimate: {
                exact: 'frees about {size}',
                'at-least': 'frees at least {size}',
                'up-to': 'frees up to {size}'
            },
            dangling: {
                menu: 'Remove dangling images…',
                title: 'Remove dangling images?',
                explain: 'Dangling images are untagged leftovers of earlier builds and pulls that no container uses.',
                nothing: 'There are no dangling images.',
                note: 'They cannot be recovered, but nothing runs from them.',
                done: 'Dangling images removed'
            },
            unused: {
                menu: 'Remove unused images…',
                title: 'Remove every unused image?',
                explain: 'Every image no container uses (running or stopped) is deleted, tagged ones included.',
                nothing: 'Every image is used by a container.',
                note: 'They are downloaded or built again the next time they are needed: the next deploy takes longer.',
                done: 'Unused images removed'
            },
            'build-cache': {
                menu: 'Clear the build cache…',
                title: 'Clear the build cache?',
                explain: 'The build cache is deleted, except what a running build uses and the layers images share with it (removing those would free nothing).',
                nothing: 'The build cache holds nothing that can be freed: what is left is in use or shared with images.',
                note: 'The next builds run without cache and take longer.',
                confirm: 'Clear the build cache',
                done: 'Build cache cleared'
            }
        }
    },
    logs: {
        formLabel: 'Log source',
        kindLabel: 'Source type',
        kind: {
            journal: 'Journal',
            file: 'File',
            container: 'Container',
            compose: 'Compose'
        },
        inputLabel: {
            journal: 'Unit (optional)',
            file: 'File path',
            container: 'Container name or ID',
            compose: 'Compose project, or project/service'
        },
        placeholder: {
            journal: 'Unit, e.g. nginx (empty: whole journal)',
            file: '/var/log/syslog',
            fileWindows: 'C:\\logs\\app.log',
            container: 'Container name or ID',
            compose: 'Project, or project/service'
        },
        invalid: {
            journal: 'Enter a unit name such as nginx or nginx.service.',
            file: 'Enter an absolute path or one in your home (~/logs/app.log), without quotes or special characters.',
            fileWindows: 'Enter an absolute path such as C:\\logs\\app.log, without quotes or special characters.',
            container: 'Enter a container name or ID (letters, digits, "_", "." and "-").',
            compose: 'Enter a project name, or project/service (letters, digits, "_", "." and "-").'
        },
        start: 'Start',
        restart: 'Restart',
        stop: 'Stop',
        status: {
            idle: 'Idle',
            connecting: 'Connecting',
            streaming: 'Streaming',
            ended: 'Ended',
            endedCode: 'Ended (exit {code})',
            error: 'Stopped by an error'
        },
        backendLost: 'The connection to ShellMind was lost.',
        emptyTitle: 'Follow a log live',
        emptyHint: 'Pick the journal, a file or a container and press Start. New lines appear as they are written.',
        count: '{count} lines',
        countOne: '1 line',
        countFiltered: '{shown} of {total} lines',
        filter: 'Filter lines',
        regex: 'Use a regular expression',
        badRegex: 'Invalid regular expression: matching it as plain text.',
        pause: 'Pause',
        resume: 'Resume',
        follow: 'Keep scrolled to the newest line',
        clear: 'Clear the view',
        download: 'Download as a file',
        maxLines: 'Lines to keep',
        maxLinesOption: '{count}k',
        pausedCount: 'Paused: {count} new lines waiting',
        discarded: '{count} older lines removed to stay within the limit',
        dropped: '{size} skipped because the view could not keep up',
        outputLabel: 'Log output',
        waiting: 'Waiting for output…',
        noLines: 'No lines.'
    }
};
