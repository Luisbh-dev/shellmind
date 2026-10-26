// Status dashboard snapshot (GET /api/servers/:id/status).
// shared/ is framework-free: no Node, DOM, React or socket.io imports.
//
// A section the host could not report is null (and named in `unavailable`)
// rather than zero, so the UI never shows a made-up 0%.

export type StatusPlatform = "linux" | "windows";

export type StatusSection = "cpu" | "memory" | "swap" | "load" | "disks" | "processes" | "network" | "failedUnits" | "users";

export type StatusDisk = {
    // Device (Linux) or drive letter (Windows).
    name: string;
    mount: string;
    fsType: string | null;
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
};

export type StatusProcess = {
    pid: number;
    name: string;
    // CPU used during the sample, where 100 is one full core (like top), so a
    // multi-threaded process can go above 100.
    cpuPercent: number;
    memoryMB: number | null;
    memoryPercent: number | null;
};

export type StatusInterface = {
    name: string;
    rxBytesPerSec: number;
    txBytesPerSec: number;
};

export type StatusSnapshot = {
    platform: StatusPlatform;
    // Epoch ms when the backend finished collecting.
    collectedAt: number;
    hostname: string;
    os: string;
    kernel: string | null;
    uptimeSeconds: number | null;
    cpu: {
        // Whole machine, 0-100, measured over `sampleSeconds`.
        usagePercent: number;
        cores: number | null;
        // Linux: share of time waiting for I/O.
        iowaitPercent: number | null;
    } | null;
    memory: {
        totalMB: number;
        // Total minus available (MemAvailable on Linux): what applications hold.
        usedMB: number;
        availableMB: number;
        usagePercent: number;
    } | null;
    swap: {
        totalMB: number;
        usedMB: number;
        usagePercent: number;
    } | null;
    load: {
        one: number;
        five: number;
        fifteen: number;
    } | null;
    // Local filesystems, deduplicated (pseudo, network and container mounts left out).
    storage: {
        totalGB: number;
        usedGB: number;
        freeGB: number;
        usagePercent: number;
    } | null;
    disks: StatusDisk[];
    // Top processes by CPU used during the sample.
    processes: StatusProcess[];
    network: {
        rxBytesPerSec: number;
        txBytesPerSec: number;
        interfaces: StatusInterface[];
    } | null;
    // Failed systemd units (null without systemd, e.g. on Windows).
    failedUnits: number | null;
    // Distinct users with a login session.
    loggedInUsers: number | null;
    // Length of the CPU / network / process sample.
    sampleSeconds: number;
    unavailable: StatusSection[];
    // Windows: the account is not an administrator, and Windows lets only
    // administrators use WMI over SSH. What it reports comes from elsewhere,
    // without the processor load, the paging files and the signed-in users;
    // the processes are only the account's own.
    limited?: true;
};
