import {
    CONTAINER_ACTIONS,
    isValidContainerRef,
    type ComposeProject,
    type ContainerAction,
    type ContainerEngine,
    type ContainerHealth,
    type ContainerInfo,
    type ContainerInspectSummary,
    type ContainerList,
    type ContainerPortBinding,
    type ContainerStats,
    type OpsCapabilities
} from "../../shared/ops";
import type { ExecResult } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";
import type { PreparedAction } from "./actions";
import {
    POSIX_SECTION_FUNCTION,
    SECTION_MARKER,
    asNumber,
    asString,
    commandFailure,
    ensureArray,
    extractJson,
    isRecord,
    parseSections,
    psQuote,
    runPosixScript,
    runPowerShell,
    shellQuote,
    type RunOptions
} from "./remote";
import { InvalidOpsInputError, OpsUnsupportedError } from "./services";

// Docker / Podman containers. Every command is `<engine> <fixed verb>
// <validated ref>`; on Windows hosts the same arguments run from PowerShell.

const LIST_TIMEOUT_MS = 20_000;
// `stats --no-stream` samples for about two seconds per container batch.
const STATS_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 90_000;
const CONTAINER_LOG_MAX_LINES = 2000;

export type Engine = { engine: ContainerEngine; caps: OpsCapabilities };

export function requireEngine(caps: OpsCapabilities): Engine {
    if (!caps.containers.engine) throw new OpsUnsupportedError(caps.containers.problem ?? "No container engine is available on this server.");
    return { engine: caps.containers.engine, caps };
}

export function requireContainerRef(ref: string): string {
    if (!isValidContainerRef(ref)) throw new InvalidOpsInputError(`"${ref.slice(0, 80)}" is not a valid container name or id.`);
    return ref;
}

// The engine invocation with quoted arguments, as the remote shell runs it.
export function engineCommand({ engine, caps }: Engine, args: string[]): string {
    if (caps.platform === "windows") return `& ${engine} ${args.map(psQuote).join(" ")}`;
    return `${caps.containers.sudo ? "sudo -n " : ""}${engine} ${args.map(shellQuote).join(" ")}`;
}

// Runs one engine command with stdout and stderr merged (the engine prints
// container stderr and its own errors there).
export function runEngine(lease: SshLease, target: Engine, args: string[], options: RunOptions): Promise<ExecResult> {
    const command = engineCommand(target, args);
    if (target.caps.platform === "windows") return runPowerShell(lease, `$ErrorActionPreference='Continue'\n${command} 2>&1 | % { "$_" }\nexit $LASTEXITCODE\n`, options);
    return runPosixScript(lease, `${command} 2>&1\n`, options);
}

function listArgs(engine: ContainerEngine): string[] {
    return engine === "podman" ? ["ps", "-a", "--format", "json"] : ["ps", "-a", "--no-trunc", "--format", "{{json .}}"];
}

export function listContainersScript(target: Engine): string {
    const ps = engineCommand(target, listArgs(target.engine));
    const compose = target.caps.containers.compose ? engineCommand(target, ["compose", "ls", "-a", "--format", "json"]) : null;
    if (target.caps.platform === "windows") {
        return [
            "$ErrorActionPreference='Continue'",
            `'${SECTION_MARKER}ps'`,
            `${ps} 2>&1 | % { "$_" }`,
            `'${SECTION_MARKER}rc'`,
            "$LASTEXITCODE",
            ...(compose ? [`'${SECTION_MARKER}compose'`, `${compose} 2>$null`] : []),
            `'${SECTION_MARKER}end'`,
            ""
        ].join("\n");
    }
    return [
        POSIX_SECTION_FUNCTION,
        "m ps",
        `${ps} 2>&1`,
        "r=$?",
        "m rc",
        "echo $r",
        ...(compose ? ["m compose", `${compose} 2>/dev/null`] : []),
        "m end",
        ""
    ].join("\n");
}

// A piece of Docker's label string that starts a new "key=value" pair; any
// other piece continues the previous value, which had a comma in it (Compose
// lists several config files as "a.yml,b.yml"). Paths never pass for keys.
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*=/;

// `docker ps --format '{{json .}}'` prints the labels as one "k=v,k2=v2"
// string; Podman as an object.
export function parseLabels(labels: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (isRecord(labels)) {
        for (const [key, value] of Object.entries(labels)) result[key] = asString(value);
        return result;
    }
    if (typeof labels !== "string" || !labels) return result;
    let current: string | null = null;
    for (const piece of labels.split(",")) {
        if (LABEL_KEY.test(piece) && !piece.startsWith("/")) {
            const index = piece.indexOf("=");
            current = piece.slice(0, index);
            result[current] = piece.slice(index + 1);
        } else if (current !== null) {
            result[current] += `,${piece}`;
        }
    }
    return result;
}

export const COMPOSE_PROJECT = "com.docker.compose.project";
export const COMPOSE_SERVICE = "com.docker.compose.service";
export const COMPOSE_WORKING_DIR = "com.docker.compose.project.working_dir";
export const COMPOSE_CONFIG_FILES = "com.docker.compose.project.config_files";
export const COMPOSE_ENV_FILE = "com.docker.compose.project.environment_file";

// `State` came with Docker 20.10; older engines (still common on RHEL/CentOS
// 7) only print the status text: "Up 3 days (Paused)", "Exited (0) 2 hours ago"...
const STATUS_STATES: Array<[RegExp, string]> = [
    [/^Up\b.*\(Paused\)/i, "paused"],
    [/^Up\b/i, "running"],
    [/^Exited\b/i, "exited"],
    [/^Created\b/i, "created"],
    [/^Restarting\b/i, "restarting"],
    [/^Removal In Progress/i, "removing"],
    [/^Dead\b/i, "dead"]
];

export function stateFromStatus(status: string): string {
    const text = status.trim();
    return STATUS_STATES.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown";
}

// A listed container with all its labels (the Compose view reads more of them).
export type ContainerRecord = { info: ContainerInfo; labels: Record<string, string> };

// One JSON object per line (`--format '{{json .}}'`); other lines are skipped.
export function jsonLines(raw: string): Record<string, unknown>[] {
    return raw.split("\n").flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return [];
        try {
            const item: unknown = JSON.parse(trimmed);
            return isRecord(item) ? [item] : [];
        } catch {
            return [];
        }
    });
}

function dockerRecords(raw: string): ContainerRecord[] {
    return jsonLines(raw).flatMap((item) => {
        const id = asString(item.ID);
        if (!id) return [];
        const status = asString(item.Status);
        const labels = parseLabels(item.Labels);
        return [{
            labels,
            info: {
                id,
                name: asString(item.Names).split(",")[0] || id.slice(0, 12),
                image: asString(item.Image),
                state: asString(item.State).toLowerCase() || stateFromStatus(status),
                status,
                ports: asString(item.Ports),
                createdAt: asString(item.CreatedAt) || null,
                composeProject: labels[COMPOSE_PROJECT] || null,
                composeService: labels[COMPOSE_SERVICE] || null
            }
        }];
    });
}

export function parseContainerRecords(engine: ContainerEngine, raw: string): ContainerRecord[] {
    return engine === "podman" ? podmanRecords(raw) : dockerRecords(raw);
}

// `docker ps --format '{{json .}}'`: one object per line.
export function parseDockerPs(raw: string): ContainerInfo[] {
    return dockerRecords(raw).map((record) => record.info);
}

function podmanPorts(ports: unknown): string {
    return ensureArray(ports).filter(isRecord).map((port) => {
        const host = asNumber(port.host_port);
        const container = asNumber(port.container_port);
        const protocol = asString(port.protocol) || "tcp";
        const hostIp = asString(port.host_ip);
        return host ? `${hostIp || "0.0.0.0"}:${host}->${container}/${protocol}` : `${container}/${protocol}`;
    }).join(", ");
}

function podmanRecords(raw: string): ContainerRecord[] {
    return ensureArray(extractJson(raw)).filter(isRecord).flatMap((item) => {
        const id = asString(item.Id) || asString(item.ID);
        if (!id) return [];
        const names = ensureArray(item.Names).map(asString).filter(Boolean);
        const created = asNumber(item.Created);
        const labels = parseLabels(item.Labels);
        return [{
            labels,
            info: {
                id,
                name: names[0] || id.slice(0, 12),
                image: asString(item.Image),
                state: asString(item.State).toLowerCase() || "unknown",
                status: asString(item.Status),
                ports: podmanPorts(item.Ports),
                createdAt: created ? new Date(created * 1000).toISOString() : asString(item.CreatedAt) || null,
                composeProject: labels[COMPOSE_PROJECT] || labels["io.podman.compose.project"] || null,
                composeService: labels[COMPOSE_SERVICE] || null
            }
        }];
    });
}

// `podman ps --format json`: one JSON array.
export function parsePodmanPs(raw: string): ContainerInfo[] {
    return podmanRecords(raw).map((record) => record.info);
}

export function parseComposeProjects(raw: string | undefined): ComposeProject[] {
    return ensureArray(extractJson(raw ?? "")).filter(isRecord).flatMap((item) => {
        const name = asString(item.Name);
        if (!name) return [];
        return [{ name, status: asString(item.Status), configFiles: asString(item.ConfigFiles) || null }];
    });
}

const STATE_ORDER: Record<string, number> = { running: 0, restarting: 1, paused: 2 };

export function parseContainerList(engine: ContainerEngine, output: string): { list: ContainerList; exitCode: number | null; raw: string } {
    const sections = parseSections(output);
    const raw = sections.get("ps") ?? "";
    const exitCode = asNumber(sections.get("rc"));
    const containers = (engine === "podman" ? parsePodmanPs(raw) : parseDockerPs(raw))
        .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || a.name.localeCompare(b.name));
    return { list: { engine, containers, projects: parseComposeProjects(sections.get("compose")) }, exitCode, raw };
}

export async function listContainers(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<ContainerList> {
    const target = requireEngine(caps);
    const script = listContainersScript(target);
    const options = { timeoutMs: LIST_TIMEOUT_MS, signal };
    const result = caps.platform === "windows" ? await runPowerShell(lease, script, options) : await runPosixScript(lease, script, options);
    const { list, exitCode, raw } = parseContainerList(target.engine, result.stdout);
    if (exitCode !== 0) throw commandFailure({ ...result, code: exitCode, stdout: raw }, "Listing containers failed");
    return list;
}

function percentValue(value: unknown): number | null {
    const number = Number.parseFloat(asString(value).replace("%", ""));
    return Number.isFinite(number) ? number : null;
}

export function parseContainerStats(engine: ContainerEngine, raw: string): ContainerStats[] {
    const items: unknown[] = engine === "podman"
        ? ensureArray(extractJson(raw))
        : raw.split("\n").flatMap((line) => {
            if (!line.trim().startsWith("{")) return [];
            try {
                return [JSON.parse(line.trim()) as unknown];
            } catch {
                return [];
            }
        });
    return items.filter(isRecord).flatMap((item) => {
        // Docker names its fields in PascalCase, Podman in snake_case (or CamelCase in older releases).
        const pick = (...keys: string[]) => keys.map((key) => item[key]).find((value) => value !== undefined && value !== null);
        const id = asString(pick("ID", "id", "ContainerID", "Container"));
        if (!id) return [];
        return [{
            id,
            name: asString(pick("Name", "name")) || id.slice(0, 12),
            cpuPercent: percentValue(pick("CPUPerc", "cpu_percent", "CPU")),
            memoryPercent: percentValue(pick("MemPerc", "mem_percent", "MemPerc")),
            memoryUsage: asString(pick("MemUsage", "mem_usage")),
            netIO: asString(pick("NetIO", "net_io")),
            blockIO: asString(pick("BlockIO", "block_io")),
            pids: asNumber(pick("PIDs", "pids", "PIDS"))
        }];
    });
}

export async function containerStats(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<ContainerStats[]> {
    const target = requireEngine(caps);
    const args = target.engine === "podman"
        ? ["stats", "--no-stream", "--format", "json"]
        : ["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"];
    const result = await runEngine(lease, target, args, { timeoutMs: STATS_TIMEOUT_MS, signal });
    if (result.code !== 0) throw commandFailure(result, "Reading container stats failed");
    return parseContainerStats(target.engine, result.stdout);
}

export async function inspectContainer(lease: SshLease, caps: OpsCapabilities, ref: string, signal?: AbortSignal): Promise<unknown> {
    const target = requireEngine(caps);
    requireContainerRef(ref);
    const result = await runEngine(lease, target, ["inspect", "--type", "container", ref], { timeoutMs: LIST_TIMEOUT_MS, signal });
    if (result.code !== 0) throw commandFailure(result, "Inspecting the container failed");
    const parsed = ensureArray(extractJson(result.stdout));
    return parsed[0] ?? null;
}

// One container's usage now (the detail panel's snapshot; zeros when stopped).
export async function containerStatsOf(lease: SshLease, caps: OpsCapabilities, ref: string, signal?: AbortSignal): Promise<ContainerStats | null> {
    const target = requireEngine(caps);
    requireContainerRef(ref);
    const args = target.engine === "podman"
        ? ["stats", "--no-stream", "--format", "json", ref]
        : ["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", ref];
    const result = await runEngine(lease, target, args, { timeoutMs: STATS_TIMEOUT_MS, signal });
    if (result.code !== 0) throw commandFailure(result, "Reading the container's usage failed");
    return parseContainerStats(target.engine, result.stdout)[0] ?? null;
}

// Docker prints the zero time for "never" (a container that never stopped).
function timestamp(value: unknown): string | null {
    const text = asString(value);
    return text && !text.startsWith("0001-01-01") ? text : null;
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const strings = (value: unknown): string[] => ensureArray(value).map(asString).filter(Boolean);

function inspectPorts(network: Record<string, unknown>, host: Record<string, unknown>): ContainerPortBinding[] {
    const published = isRecord(network.Ports) && Object.keys(network.Ports).length ? network.Ports : record(host.PortBindings);
    const ports: ContainerPortBinding[] = [];
    for (const [port, bindings] of Object.entries(published)) {
        const list = ensureArray(bindings).filter(isRecord);
        if (!list.length) {
            ports.push({ port, hostIp: null, hostPort: null });
            continue;
        }
        for (const binding of list) {
            const hostIp = asString(binding.HostIp) || null;
            const hostPort = asString(binding.HostPort) || null;
            // Docker publishes on IPv4 and IPv6 alike: one row says it.
            if (hostIp === "::" && ports.some((entry) => entry.port === port && entry.hostPort === hostPort && entry.hostIp === "0.0.0.0")) continue;
            ports.push({ port, hostIp, hostPort });
        }
    }
    return ports.sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }));
}

function inspectHealth(state: Record<string, unknown>): ContainerHealth | null {
    // Podman before 4.3 called it Healthcheck.
    const health = isRecord(state.Health) ? state.Health : isRecord(state.Healthcheck) ? state.Healthcheck : null;
    if (!health || !asString(health.Status)) return null;
    return {
        status: asString(health.Status).toLowerCase(),
        failingStreak: asNumber(health.FailingStreak) ?? 0,
        log: ensureArray(health.Log).filter(isRecord).slice(-5).map((entry) => ({
            start: timestamp(entry.Start),
            exitCode: asNumber(entry.ExitCode),
            output: asString(entry.Output).trim().slice(0, 2000)
        }))
    };
}

// The parts of `inspect` the container panel shows (Docker and Podman).
export function summarizeInspect(raw: unknown): ContainerInspectSummary | null {
    if (!isRecord(raw)) return null;
    const state = record(raw.State);
    const config = record(raw.Config);
    const host = record(raw.HostConfig);
    const network = record(raw.NetworkSettings);
    const labels = parseLabels(config.Labels);
    const restart = record(host.RestartPolicy);
    const restartName = asString(restart.Name);
    const retries = asNumber(restart.MaximumRetryCount);
    const command = [...strings(config.Entrypoint), ...strings(config.Cmd)];
    const project = labels[COMPOSE_PROJECT] || labels["io.podman.compose.project"];
    return {
        id: asString(raw.Id) || asString(raw.ID),
        name: asString(raw.Name).replace(/^\//, ""),
        image: asString(config.Image) || asString(raw.ImageName),
        imageId: asString(raw.Image) || null,
        created: timestamp(raw.Created),
        state: {
            status: asString(state.Status).toLowerCase() || "unknown",
            running: state.Running === true,
            exitCode: asNumber(state.ExitCode),
            oomKilled: state.OOMKilled === true,
            error: asString(state.Error) || null,
            startedAt: timestamp(state.StartedAt),
            finishedAt: timestamp(state.FinishedAt),
            pid: asNumber(state.Pid) || null
        },
        restartPolicy: restartName ? (restartName === "on-failure" && retries ? `${restartName}:${retries}` : restartName) : null,
        restartCount: asNumber(raw.RestartCount),
        command: command.length ? command.join(" ") : [asString(raw.Path), ...strings(raw.Args)].filter(Boolean).join(" "),
        workingDir: asString(config.WorkingDir) || null,
        user: asString(config.User) || null,
        env: strings(config.Env).map((entry) => {
            const index = entry.indexOf("=");
            return index < 0 ? { name: entry, value: "" } : { name: entry.slice(0, index), value: entry.slice(index + 1) };
        }),
        mounts: ensureArray(raw.Mounts).filter(isRecord).map((mount) => ({
            type: asString(mount.Type) || "bind",
            name: asString(mount.Name) || null,
            source: asString(mount.Source),
            destination: asString(mount.Destination),
            readOnly: mount.RW === false
        })),
        ports: inspectPorts(network, host),
        networkMode: asString(host.NetworkMode) || null,
        networks: Object.entries(record(network.Networks)).map(([name, value]) => {
            const entry = record(value);
            return {
                name,
                ipAddress: asString(entry.IPAddress) || null,
                gateway: asString(entry.Gateway) || null,
                macAddress: asString(entry.MacAddress) || null,
                aliases: [...new Set([...strings(entry.Aliases), ...strings(entry.DNSNames)])]
            };
        }),
        health: inspectHealth(state),
        compose: project
            ? {
                project,
                service: labels[COMPOSE_SERVICE] || null,
                workingDir: labels[COMPOSE_WORKING_DIR] || null,
                configFiles: (labels[COMPOSE_CONFIG_FILES] ?? "").split(",").map((file) => file.trim()).filter(Boolean)
            }
            : null
    };
}

// `maxOutputBytes`: below exec's default (a diagnosis keeps far less).
export async function containerLogs(lease: SshLease, caps: OpsCapabilities, ref: string, lines: number, signal?: AbortSignal, maxOutputBytes?: number): Promise<string> {
    const target = requireEngine(caps);
    requireContainerRef(ref);
    const count = Math.min(Math.max(Math.floor(lines) || 200, 1), CONTAINER_LOG_MAX_LINES);
    const result = await runEngine(lease, target, ["logs", "--tail", String(count), "--timestamps", ref], { timeoutMs: LIST_TIMEOUT_MS, signal, ...(maxOutputBytes ? { maxOutputBytes } : {}) });
    if (result.code !== 0) throw commandFailure(result, "Reading the container logs failed");
    return result.stdout;
}

function isContainerAction(action: string): action is ContainerAction {
    return (CONTAINER_ACTIONS as readonly string[]).includes(action);
}

const ACTION_ARGS: Record<ContainerAction, string[]> = {
    start: ["start"],
    stop: ["stop"],
    restart: ["restart"],
    // Confirmed in the UI as "stop if running and delete"; volumes are kept.
    remove: ["rm", "-f"]
};

export function prepareContainerAction(caps: OpsCapabilities, ref: string, action: string): PreparedAction {
    const target = requireEngine(caps);
    requireContainerRef(ref);
    if (!isContainerAction(action)) throw new InvalidOpsInputError(`"${action.slice(0, 40)}" is not a container action.`);
    const args = [...ACTION_ARGS[action], ref];
    return {
        display: engineCommand(target, args).replace(/^& /, ""),
        meta: { kind: "container", action, target: ref },
        run: (lease, signal) => runEngine(lease, target, args, { timeoutMs: ACTION_TIMEOUT_MS, signal })
    };
}
