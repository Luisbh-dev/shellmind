import type { ChatEvidenceSection } from "../../../shared/chat";
import { containerLogs, inspectContainer, requireContainerRef, requireEngine } from "../../ops/containers";
import { asNumber, asString, ensureArray, isRecord } from "../../ops/remote";
import { redactArgv } from "../redact";
import { EVIDENCE_LOG_LINES, EVIDENCE_OUTPUT_MAX_BYTES, type EvidenceContext } from "./context";
import { attempt, logSection, textSection } from "./sections";

// A container's evidence: a summary of `inspect` (state, exit code, OOM
// kill, restarts, health checks, ports, mounts, limits) and its last log
// lines. The environment variables are left out entirely: that is where
// containers keep their passwords and tokens. The command line stays (it
// explains many failures) with the values of credential options masked.

const INSPECT_CHARS = 5000;
const LOGS_CHARS = 14_000;

const MIB = 1024 * 1024;

function field(record: unknown, key: string): unknown {
    return isRecord(record) ? record[key] : undefined;
}

function line(label: string, value: string | null | undefined): string | null {
    return value ? `${label}: ${value}` : null;
}

function yesNo(value: unknown): string | null {
    return value === true ? "yes" : value === false ? "no" : null;
}

// A command line (Entrypoint, Cmd), with the values of credential options
// masked argument by argument (`--requirepass`, `<password with blanks>`).
function commandLine(value: unknown): string {
    return redactArgv(ensureArray(value as unknown[]).map(asString).filter(Boolean)).join(" ");
}

function ports(network: unknown): string | null {
    const bindings = field(network, "Ports");
    if (!isRecord(bindings)) return null;
    const list = Object.entries(bindings).map(([port, hosts]) => {
        const published = ensureArray(hosts as unknown[]).filter(isRecord).map((host) => `${asString(host.HostIp) || "0.0.0.0"}:${asString(host.HostPort)}`);
        return published.length ? `${published.join(", ")} -> ${port}` : `${port} (not published)`;
    });
    return list.length ? list.join("; ") : null;
}

function mounts(value: unknown): string | null {
    const list = ensureArray(value as unknown[]).filter(isRecord).map((mount) => {
        const source = asString(mount.Source) || asString(mount.Name);
        return `${source} -> ${asString(mount.Destination)} (${asString(mount.Type) || "bind"}, ${mount.RW === false ? "ro" : "rw"})`;
    });
    return list.length ? list.join("; ") : null;
}

function networks(network: unknown): string | null {
    const attached = field(network, "Networks");
    if (!isRecord(attached)) return null;
    const list = Object.entries(attached).map(([name, info]) => {
        const ip = asString(field(info, "IPAddress"));
        return ip ? `${name} (${ip})` : name;
    });
    return list.length ? list.join(", ") : null;
}

function limits(host: unknown): string | null {
    const parts: string[] = [];
    const memory = asNumber(field(host, "Memory"));
    if (memory) parts.push(`memory ${Math.round(memory / MIB)} MiB`);
    const cpus = asNumber(field(host, "NanoCpus"));
    if (cpus) parts.push(`cpus ${cpus / 1e9}`);
    const pids = asNumber(field(host, "PidsLimit"));
    if (pids && pids > 0) parts.push(`pids ${pids}`);
    return parts.length ? parts.join(", ") : null;
}

function health(state: unknown): string[] {
    const info = field(state, "Health");
    if (!isRecord(info)) return [];
    const checks = ensureArray(info.Log as unknown[]).filter(isRecord).slice(-3).map((check) => {
        const output = asString(check.Output).replace(/\s+/g, " ").trim().slice(0, 300);
        return `  ${asString(check.End) || asString(check.Start)} exit ${asString(check.ExitCode)}${output ? `: ${output}` : ""}`;
    });
    return [`Health: ${asString(info.Status) || "unknown"} (failing streak ${asString(info.FailingStreak) || "0"})`, ...(checks.length ? ["Last health checks:", ...checks] : [])];
}

// The parts of `docker inspect` / `podman inspect` that explain a failure.
export function summarizeInspect(inspect: unknown): string {
    if (!isRecord(inspect)) return "(the engine returned no inspect data)";
    const state = inspect.State;
    const config = inspect.Config;
    const host = inspect.HostConfig;
    const restart = field(host, "RestartPolicy");
    const labels = field(config, "Labels");
    const env = ensureArray(field(config, "Env") as unknown[]);
    const exitCode = asString(field(state, "ExitCode"));
    const error = asString(field(state, "Error"));

    const status = [
        asString(field(state, "Status")) || "unknown",
        exitCode && exitCode !== "0" ? `exit code ${exitCode}` : exitCode === "0" ? "exit code 0" : "",
        field(state, "OOMKilled") === true ? "killed by the kernel for running out of memory (OOMKilled)" : "",
        error ? `error: ${error}` : ""
    ].filter(Boolean).join(", ");

    const compose = isRecord(labels)
        ? [asString(labels["com.docker.compose.project"]), asString(labels["com.docker.compose.service"])].filter(Boolean).join(" / ")
        : "";

    return [
        line("Name", asString(inspect.Name).replace(/^\//, "")),
        line("Image", [asString(field(config, "Image")), asString(inspect.Image).slice(0, 19)].filter(Boolean).join(" ")),
        line("State", status),
        line("Started at", asString(field(state, "StartedAt"))),
        line("Finished at", asString(field(state, "FinishedAt")).startsWith("0001-") ? "" : asString(field(state, "FinishedAt"))),
        line("Restarting", yesNo(field(state, "Restarting"))),
        line("Restart count", asString(inspect.RestartCount)),
        line("Restart policy", isRecord(restart) ? [asString(restart.Name) || "no", asNumber(restart.MaximumRetryCount) ? `max ${asString(restart.MaximumRetryCount)} retries` : ""].filter(Boolean).join(", ") : null),
        ...health(state),
        line("Entrypoint", commandLine(field(config, "Entrypoint"))),
        line("Command", commandLine(field(config, "Cmd"))),
        line("User", asString(field(config, "User"))),
        line("Working directory", asString(field(config, "WorkingDir"))),
        line("Ports", ports(inspect.NetworkSettings)),
        line("Networks", networks(inspect.NetworkSettings)),
        line("Mounts", mounts(inspect.Mounts)),
        line("Limits", limits(host)),
        line("Compose project / service", compose),
        line("Environment", env.length ? `${env.length} variable${env.length === 1 ? "" : "s"}, left out (they may hold secrets)` : null)
    ].filter((entry): entry is string => Boolean(entry)).join("\n");
}

export async function containerEvidence(ctx: EvidenceContext, ref: string): Promise<ChatEvidenceSection[]> {
    const { lease, caps, signal } = ctx;
    const { engine } = requireEngine(caps);
    requireContainerRef(ref);

    // How the engine is reached matters for the fix's commands.
    const reach = `Engine: ${engine}${caps.containers.version ? ` ${caps.containers.version}` : ""}${caps.containers.sudo ? " (run through sudo: the login user cannot use it directly)" : ""}`;
    const inspectBase = { id: "container" as const, title: "Container state", source: `${engine} inspect ${ref}` };
    const inspect = await attempt(inspectBase, signal, async () => textSection(inspectBase, `${summarizeInspect(await inspectContainer(lease, caps, ref, signal))}\n${reach}`, INSPECT_CHARS));

    const logsBase = { id: "container-logs" as const, title: `Container logs (last ${EVIDENCE_LOG_LINES} lines)`, source: `${engine} logs --tail ${EVIDENCE_LOG_LINES} --timestamps ${ref}` };
    const logs = await attempt(logsBase, signal, async () => logSection(logsBase, await containerLogs(lease, caps, ref, EVIDENCE_LOG_LINES, signal, EVIDENCE_OUTPUT_MAX_BYTES), LOGS_CHARS));
    return [inspect, logs];
}
