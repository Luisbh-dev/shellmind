export default {
    loading: 'Collecting the first sample…',
    state: {
        live: 'Live',
        paused: 'Paused',
        pausedHint: 'Refreshing pauses while this tab or the window is hidden.',
        stale: 'Stale',
        staleHint: 'These values are from {time}; the latest refresh did not succeed.',
        error: 'Error'
    },
    updated: 'Updated {ago}',
    ago: {
        now: 'just now',
        seconds: '{count} s ago',
        minutes: '{count} min ago',
        hours: '{count} h ago'
    },
    refresh: 'Refresh now',
    retry: 'Retry now',
    errorTitle: 'Could not refresh the status',
    loadErrorTitle: 'Could not load the status',
    retryIn: 'Next attempt in {seconds} s',
    unavailable: 'Not reported',
    limitedWindows: 'This user is not an administrator, and over SSH Windows lets only administrators use WMI: the processor load, the paging files, the processes and the signed-in users are not reported.',
    tone: {
        warn: 'High',
        critical: 'Critical'
    },
    limits: 'Warning from {warn}, critical from {critical}',
    health: {
        label: 'Health: {state}',
        // The verdict of values that are no longer current.
        lastKnown: 'Last known: {state}',
        labelStale: 'Health at {time}, no longer current: {state}',
        issuesLabel: 'What needs attention',
        ok: 'Healthy',
        warn: 'Needs attention',
        critical: 'Critical',
        unknown: 'Unknown',
        okDetail: 'CPU, load, memory, disks and services are within their limits.',
        unknownDetail: 'The host reported none of the metrics the health is based on.',
        issues: {
            cpu: 'CPU {value}',
            load: 'Load {value} per core',
            memory: 'Memory {value}',
            disk: '{mount} {value} full',
            diskTotal: 'Storage {value} full',
            failedUnits: '{count} failed units',
            failedUnitsOne: '1 failed unit'
        },
        more: '+{count} more'
    },
    facts: {
        label: 'System',
        hostname: 'Hostname',
        os: 'Operating system',
        kernel: 'Kernel {value}',
        // The build of a Windows host.
        version: 'Version {value}',
        uptime: 'Up {value}',
        users: '{count} users logged in',
        usersOne: '1 user logged in',
        usersNone: 'Nobody logged in',
        failedUnits: '{count} failed units',
        failedUnitsOne: '1 failed unit',
        noFailedUnits: 'No failed units',
        failedUnitsHint: 'systemd units in the failed state (systemctl --failed)'
    },
    cpu: {
        title: 'CPU',
        cores: '{count} cores',
        coresOne: '1 core',
        iowait: 'I/O wait {value}'
    },
    memory: {
        title: 'Memory',
        used: '{used} / {total}',
        available: '{value} available',
        swap: 'Swap {used} / {total}',
        noSwap: 'No swap'
    },
    storage: {
        title: 'Storage',
        used: '{used} / {total}',
        free: '{free} free',
        hint: 'The fullest local filesystem, with the total of all of them underneath',
        fullest: 'Fullest filesystem, {mount}',
        total: '{count} filesystems · {used} / {total} in all',
        filesystems: 'Filesystems',
        caption: 'Local filesystems with their usage',
        none: 'No local filesystems were reported.'
    },
    load: {
        title: 'Load average',
        hint: 'Average number of runnable processes over 1, 5 and 15 minutes, against the number of cores',
        one: '1 min',
        five: '5 min',
        fifteen: '15 min',
        meter: 'Load average over {window}',
        value: '{value} on {cores}',
        notch: '{cores} · notch at {value}: every core busy',
        coresUnknown: 'Cores not reported · notch at {value}: one core busy'
    },
    chart: {
        stats: 'avg {avg} · peak {max}',
        collecting: 'Collecting samples…',
        showTable: '{label}: show as a table',
        showChart: '{label}: show as a chart',
        time: 'Time',
        summary: '{label}, last {count} samples: lowest {min}, highest {max}, now {now}',
        noData: '{label}: no samples yet',
        tableCaption: '{label}, newest first',
        cpu: 'CPU usage',
        memory: 'Memory usage',
        network: 'Network traffic'
    },
    network: {
        rx: 'Received',
        tx: 'Sent',
        interfaces: 'Interfaces',
        interface: 'Interface'
    },
    processes: {
        title: 'Top processes',
        caption: 'Processes that used the most CPU during the last sample',
        cpuHint: 'CPU over {seconds} s · 100% = one core',
        cpuHintShare: 'CPU over {seconds} s · 100% = all {count} cores',
        cpuPerCore: '{value} of one core',
        name: 'Process',
        pid: 'PID',
        cpu: 'CPU',
        memory: 'Memory',
        sortBy: 'Sort by {column}',
        cpuShare: '{value} of the whole machine',
        memoryShare: '{value} of the memory',
        none: 'No process data was reported.'
    },
    uptime: {
        days: '{d} d {h} h',
        hours: '{h} h {m} min',
        minutes: '{m} min'
    },
    footnote: 'Refreshes every {seconds} s while this tab is visible. Only local filesystems are counted.'
};
