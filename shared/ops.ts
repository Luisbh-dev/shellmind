// Operations panels (services, containers, live logs): HTTP payloads, the
// log streaming socket payloads and the name/path rules shared by the
// backend (which builds every remote command) and the frontend (which checks
// input before sending it). The client never sends shell text, only names.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

import type { PodLogSource } from "./k8s";
import type { ConnectionCause } from "./terminal";

export type OpsPlatform = "linux" | "windows";

export type ContainerEngine = "docker" | "podman";

// GET /api/servers/:id/ops/capabilities
export type OpsCapabilities = {
    platform: OpsPlatform;
    // The login user is root (Linux) / nothing is known (Windows: null).
    root: boolean | null;
    // Non-root user with passwordless sudo: privileged commands use `sudo -n`.
    sudo: boolean;
    // systemd is the init system (services and journal panels).
    systemd: boolean;
    journal: boolean;
    containers: {
        engine: ContainerEngine | null;
        version: string | null;
        // Runs through `sudo -n` (the user may not use the Docker socket).
        sudo: boolean;
        compose: boolean;
        // Why no engine is usable (CLI missing, daemon down, permission denied).
        problem: string | null;
    };
    detectedAt: number;
};

// --- services ---

export type ServiceActiveState = "active" | "reloading" | "inactive" | "failed" | "activating" | "deactivating" | "maintenance" | string;

export type ServiceInfo = {
    // systemd unit (nginx.service) or Windows service name.
    name: string;
    description: string;
    // systemd LOAD column (loaded, not-found, masked) / null on Windows.
    load: string | null;
    active: ServiceActiveState;
    // systemd SUB state (running, exited, dead...) / Windows Status (Running, Stopped...).
    sub: string;
    // Unit file state (enabled, disabled, static, masked...) / Windows StartType (Automatic, Manual, Disabled).
    startup: string | null;
};

// GET /api/servers/:id/ops/services
export type ServicesList = {
    services: ServiceInfo[];
    // Windows: the account may not list the services (over SSH Windows lets
    // only administrators do that): these are the ones it may still query
    // by name.
    limited?: true;
};

export type ServiceDetail = {
    name: string;
    // Key/value properties (systemctl show / Win32_Service).
    properties: Record<string, string>;
    // `systemctl status` text (Linux) or null.
    statusText: string | null;
    // Windows: running services that depend on this one (stopping or
    // restarting it stops them too). Absent on Linux.
    dependents?: string[];
};

export const LINUX_SERVICE_ACTIONS = ["start", "stop", "restart", "reload", "enable", "disable"] as const;
export const WINDOWS_SERVICE_ACTIONS = ["start", "stop", "restart"] as const;
export type ServiceAction = typeof LINUX_SERVICE_ACTIONS[number];

export type OpsActionResult = {
    ok: true;
    // The command as it ran (also what the audit log records).
    command: string;
    output: string;
};

// --- containers ---

export type ContainerInfo = {
    id: string;
    name: string;
    image: string;
    // running, exited, paused, restarting, created, dead...
    state: string;
    // Engine's human status ("Up 2 hours", "Exited (0) 3 days ago").
    status: string;
    ports: string;
    createdAt: string | null;
    composeProject: string | null;
    composeService: string | null;
};

export type ComposeProject = {
    name: string;
    status: string;
    configFiles: string | null;
};

export type ContainerList = {
    engine: ContainerEngine;
    containers: ContainerInfo[];
    // Empty when `compose ls` is unavailable.
    projects: ComposeProject[];
};

export type ContainerStats = {
    id: string;
    name: string;
    cpuPercent: number | null;
    memoryPercent: number | null;
    memoryUsage: string;
    netIO: string;
    blockIO: string;
    pids: number | null;
};

export const CONTAINER_ACTIONS = ["start", "stop", "restart", "remove"] as const;
export type ContainerAction = typeof CONTAINER_ACTIONS[number];

// --- validation ---

// systemd unit names: letters, digits, ":_.@-" and \xHH escapes, with a type suffix.
export const SYSTEMD_UNIT_PATTERN = /^(?:[A-Za-z0-9:_.@-]|\\x[0-9a-fA-F]{2}){1,240}\.(service|socket|timer|target|mount|path|slice|scope)$/;
// Windows service names (not display names).
export const WINDOWS_SERVICE_PATTERN = /^[A-Za-z0-9_.@$#+-][A-Za-z0-9 _.@$#+-]{0,255}$/;
// Container names and ids (Docker/Podman: [a-zA-Z0-9][a-zA-Z0-9_.-]*).
export const CONTAINER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Absolute POSIX path, or one in the login user's home ("~/logs/app.log"),
// without control characters, quotes or backslashes.
// eslint-disable-next-line no-control-regex -- control characters are what it rejects
export const POSIX_LOG_PATH_PATTERN = /^(?:\/|~\/)[^\0-\x1f\x7f'"\\`$]{0,1022}$/;
// Absolute Windows path on a drive letter, without the quotes PowerShell
// knows (typographic ones too: U+2018-U+201E).
// eslint-disable-next-line no-control-regex -- control characters are what it rejects
export const WINDOWS_LOG_PATH_PATTERN = /^[A-Za-z]:\\[^\0-\x1f\x7f'"`$<>|?*\u2018-\u201e]{0,1020}$/;

// "nginx" -> "nginx.service" (systemctl's own default).
export function normalizeUnitName(name: string): string {
    const trimmed = name.trim();
    return !trimmed || /\.(service|socket|timer|target|mount|path|slice|scope)$/.test(trimmed) ? trimmed : `${trimmed}.service`;
}

export function isValidServiceName(platform: OpsPlatform, name: string): boolean {
    return platform === "windows" ? WINDOWS_SERVICE_PATTERN.test(name) && name.trim() === name : SYSTEMD_UNIT_PATTERN.test(name);
}

export function isValidContainerRef(ref: string): boolean {
    return CONTAINER_REF_PATTERN.test(ref);
}

export function isValidLogPath(platform: OpsPlatform, path: string): boolean {
    if (platform === "windows") return WINDOWS_LOG_PATH_PATTERN.test(path) && !/\\\.\.(\\|$)/.test(path);
    return POSIX_LOG_PATH_PATTERN.test(path) && !/\/\.\.(\/|$)/.test(path);
}

// --- live logs (socket.io) ---

export type LogSource =
    // Whole journal, or one unit's.
    | { kind: "journal"; unit?: string }
    | { kind: "file"; path: string }
    | { kind: "container"; container: string };

export const LOG_BACKLOG_LINES = 200;
// Streams one socket may run at once (the connection also caps them).
export const MAX_LOG_STREAMS_PER_SOCKET = 3;
export const LOG_STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export type LogStartPayload = {
    // Chosen by the client; every event about the stream carries it.
    id: string;
    serverId: number;
    // W7-S3: a Compose project's logs too (see ComposeLogSource).
    source: LogStreamSource;
};

export type LogChunkPayload = {
    id: string;
    data: string;
    // Bytes left out because the client could not keep up.
    dropped?: number;
};

export type LogErrorPayload = {
    id: string;
    code: string;
    message: string;
    // SSH_FAILED: the connection failure's own code (see ConnectionCause).
    connection?: ConnectionCause;
};

export type LogEndPayload = {
    id: string;
    // Exit status of the remote command (null: stopped or connection lost).
    code: number | null;
};

// --- W7-S3: containers v2 (container shells, Compose projects, images) ---

// Shells a container terminal may ask for (TerminalAttach.shell): a bare
// name looked up on the container's PATH or an absolute path. Without one the
// backend opens bash when the container has it, else sh.
export const CONTAINER_SHELL_PATTERN = /^(?:[A-Za-z0-9._+-]{1,64}|(?:\/[A-Za-z0-9._+-]{1,64}){1,8})$/;
export const CONTAINER_SHELLS = ["bash", "sh", "ash", "zsh"] as const;

export function isValidContainerShell(shell: string): boolean {
    return CONTAINER_SHELL_PATTERN.test(shell) && !/(^|\/)\.\.?(\/|$)/.test(shell);
}

// Compose project and service names (Compose itself lowercases project names;
// podman-compose keeps the directory's name).
export const COMPOSE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidComposeName(name: string): boolean {
    return COMPOSE_NAME_PATTERN.test(name);
}

// The live logs of a Compose project (or of one of its services), merged the
// way `compose logs -f` prints them. Kept apart from LogSource, which also
// names what the AI chat may be pointed at (ChatAttachment).
export type ComposeLogSource = { kind: "compose"; project: string; service?: string };
// W8-T2: a Kubernetes pod's container (kubectl logs, see shared/k8s.ts).
export type LogStreamSource = LogSource | ComposeLogSource | PodLogSource;

// GET /api/servers/:id/ops/containers/:ref -> { inspect, summary }: the parts
// of `inspect` the container panel shows. Environment values are secrets more
// often than not: the panel masks them until asked.
export type ContainerEnvVar = { name: string; value: string };

export type ContainerMount = {
    // bind, volume, tmpfs...
    type: string;
    // Volume name (volumes only).
    name: string | null;
    source: string;
    destination: string;
    readOnly: boolean;
};

export type ContainerPortBinding = {
    // "80/tcp"
    port: string;
    // Null when the port is only exposed (not published on the host).
    hostIp: string | null;
    hostPort: string | null;
};

export type ContainerNetwork = {
    name: string;
    ipAddress: string | null;
    gateway: string | null;
    macAddress: string | null;
    aliases: string[];
};

export type ContainerHealth = {
    // starting, healthy, unhealthy
    status: string;
    failingStreak: number;
    // Most recent check last.
    log: Array<{ start: string | null; exitCode: number | null; output: string }>;
};

export type ContainerInspectSummary = {
    id: string;
    name: string;
    image: string;
    imageId: string | null;
    created: string | null;
    state: {
        status: string;
        running: boolean;
        exitCode: number | null;
        oomKilled: boolean;
        error: string | null;
        startedAt: string | null;
        finishedAt: string | null;
        pid: number | null;
    };
    restartPolicy: string | null;
    restartCount: number | null;
    command: string;
    workingDir: string | null;
    user: string | null;
    env: ContainerEnvVar[];
    mounts: ContainerMount[];
    ports: ContainerPortBinding[];
    networkMode: string | null;
    networks: ContainerNetwork[];
    health: ContainerHealth | null;
    compose: { project: string; service: string | null; workingDir: string | null; configFiles: string[] } | null;
};

// --- compose ---

// The Compose implementation a server offers: the Docker CLI plugin (v2+),
// `podman compose` (Podman 4.1+, through its provider) or podman-compose.
export type ComposeTool = "docker compose" | "podman compose" | "podman-compose";

export type ComposeProjectInfo = {
    name: string;
    // From the containers' labels (where `compose up` ran and with which files).
    workingDir: string | null;
    configFiles: string[];
    // Config files the server no longer has (moved or deleted): `up` and
    // `update` cannot run then; Docker Compose still stops, restarts, takes
    // down and follows the logs of the project by its name.
    missingFiles: string[];
    containers: ContainerInfo[];
    running: number;
    // False when the name (a container label) is not one ShellMind passes to
    // Compose (COMPOSE_NAME_PATTERN): the project is listed, nothing runs for it.
    actionable: boolean;
};

// GET /api/servers/:id/ops/compose
export type ComposeOverview = {
    engine: ContainerEngine;
    // Null when the server has no Compose (`problem` says what is missing).
    tool: ComposeTool | null;
    problem: string | null;
    projects: ComposeProjectInfo[];
};

// up       `up -d`: creates missing containers, recreates the changed ones
// update   `pull` then `up -d`: newer images, recreated containers
// restart / stop
// down     `down`: removes the containers and networks (never volumes or images)
export const COMPOSE_ACTIONS = ["up", "update", "restart", "stop", "down"] as const;
export type ComposeAction = typeof COMPOSE_ACTIONS[number];
// Actions that may target one service of the project.
export const COMPOSE_SERVICE_ACTIONS: readonly ComposeAction[] = ["up", "update", "restart", "stop"];
// Actions that need the project's config files (the others work by name).
export const COMPOSE_FILE_ACTIONS: readonly ComposeAction[] = ["up", "update"];

// POST /api/servers/:id/ops/compose/:project/:action, body { service? }
export type ComposeActionRequest = { service?: string };

// --- images ---

export type ImageInfo = {
    // Full id (sha256:...).
    id: string;
    // Null for an untagged image.
    repository: string | null;
    tag: string | null;
    // "repository:tag", what `image rm` is given for a tagged image.
    reference: string | null;
    // Bytes (the engine prints them rounded to three digits).
    size: number | null;
    createdAt: string | null;
    createdSince: string | null;
    // Containers created from it, running or stopped.
    containers: number;
    // Untagged and no other image builds on it: `image prune` removes it.
    dangling: boolean;
};

// GET /api/servers/:id/ops/images
export type ImageList = {
    engine: ContainerEngine;
    images: ImageInfo[];
};

export type DiskUsageKind = "images" | "containers" | "volumes" | "build-cache";

export type DiskUsageRow = {
    kind: DiskUsageKind;
    count: number | null;
    active: number | null;
    // Bytes.
    size: number | null;
    reclaimable: number | null;
};

// GET /api/servers/:id/ops/disk-usage (`system df`; it can take a few seconds
// on a busy host, so it loads apart from the image list).
export type DiskUsage = {
    rows: DiskUsageRow[];
    // Bytes only that image holds (no other image shares them), by image id,
    // when the engine reports it (Docker 23+).
    uniqueSizes: Record<string, number>;
};

// dangling     untagged images nothing builds on (`image prune`)
// unused       every image no container uses, tagged or not (`image prune -a`)
// build-cache  the builder's cache (`builder prune`, Docker only)
export const PRUNE_MODES = ["dangling", "unused", "build-cache"] as const;
export type PruneMode = typeof PRUNE_MODES[number];

// GET /api/servers/:id/ops/images/prune-preview?mode=...: what a prune would
// remove now and the space that frees: as the engine reports it ("exact"),
// at least the layers no other image shares ("at-least"), or at most the sum
// of the image sizes when the engine reports no shared sizes ("up-to").
export type PrunePreview = {
    mode: PruneMode;
    images: ImageInfo[];
    bytes: number | null;
    estimate: "exact" | "at-least" | "up-to";
};

// POST /api/servers/:id/ops/images/prune, body { mode }
export type PruneResult = OpsActionResult & {
    // "Total reclaimed space" as the engine reported it (null: not reported).
    reclaimedBytes: number | null;
};

// POST /api/servers/:id/ops/images/remove, body { ref }: an image id or a
// "repository:tag" reference (the request names an image, the backend builds
// `image rm` for it).
export const IMAGE_REF_PATTERN = /^(?:sha256:[a-f0-9]{64}|[a-f0-9]{12,64}|[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254})$/;

export function isValidImageRef(ref: string): boolean {
    return IMAGE_REF_PATTERN.test(ref) && !ref.includes("..") && !ref.includes("//");
}
