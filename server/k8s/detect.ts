import { K8S_INSTALL_URL, isValidK8sContext, type K8sContext, type K8sRunner, type K8sStatus } from "../../shared/k8s";
import { localProcessEnv } from "../local/env";
import { resolveExecutable } from "../local/resolve";
import { POSIX_SECTION_FUNCTION, asString, extractJson, isRecord, parseSections, runPosixScript } from "../ops/remote";
import type { SshLease } from "../ssh/pool";
import { kubectlMessage } from "./errors";
import { localRunner } from "./runner";

// Whether a server can run kubectl, and with which kubeconfig contexts: the
// first thing the Kubernetes tab asks. Only local files are read (`config
// view` prints no secrets: certificates and tokens come back redacted, and
// nothing of it but the context names, clusters, API URLs and namespaces
// leaves the backend); no cluster is contacted.

const DETECT_TIMEOUT_MS = 20_000;
const MAX_UNSUPPORTED_CONTEXTS = 20;

// Where kubectl usually lives, also when the login shell's PATH (a
// non-interactive SSH session's) leaves those out.
const EXTRA_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/snap/bin:$HOME/.local/bin:$HOME/bin";

// The kubectl path an SSH detection may report: absolute, plain characters.
const REMOTE_PATH = /^\/[A-Za-z0-9._+/-]{1,255}$/;

// Prints kubectl's path and client version, `config view` of the login user
// (and its exit status), and the same for root through `sudo -n` when the
// user's kubeconfig has no context while passwordless sudo works (a k3s
// node keeps the cluster's kubeconfig root-only).
export const SSH_DETECT_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    `PATH="$PATH:${EXTRA_PATH}"`,
    "export PATH",
    POSIX_SECTION_FUNCTION,
    "k=$(command -v kubectl 2>/dev/null)",
    "m path",
    "printf '%s\\n' \"$k\"",
    "case \"$k\" in /*)",
    "  m version",
    "  \"$k\" version --client -o json 2>/dev/null | head -c 20000",
    "  c=$(\"$k\" config view -o json 2>&1); r=$?",
    "  m config",
    "  printf '%s\\n' \"$c\" | head -c 2000000",
    "  m config-exit",
    "  echo \"$r\"",
    "  if [ \"$(id -u 2>/dev/null)\" != 0 ] && ! printf '%s' \"$c\" | grep -q '\"context\":' && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
    "    m sudo-config",
    "    sudo -n \"$k\" config view -o json 2>&1 | head -c 2000000",
    "    m sudo-exit",
    "    echo \"$?\"",
    "  fi",
    ";; esac",
    "m end",
    ""
].join("\n");

export type ParsedConfig = { contexts: K8sContext[]; currentContext: string | null; unsupported: string[] };

// The contexts of `kubectl config view -o json`, with their cluster's API
// URL. Contexts whose names ShellMind cannot pass safely are set apart.
export function parseConfigView(value: unknown): ParsedConfig {
    if (!isRecord(value)) return { contexts: [], currentContext: null, unsupported: [] };
    const servers = new Map<string, string>();
    for (const entry of Array.isArray(value.clusters) ? value.clusters : []) {
        if (!isRecord(entry) || !isRecord(entry.cluster)) continue;
        const server = asString(entry.cluster.server);
        if (server) servers.set(asString(entry.name), server.slice(0, 300));
    }
    const contexts: K8sContext[] = [];
    const unsupported: string[] = [];
    for (const entry of Array.isArray(value.contexts) ? value.contexts : []) {
        if (!isRecord(entry)) continue;
        const name = asString(entry.name);
        if (!name) continue;
        if (!isValidK8sContext(name)) {
            if (unsupported.length < MAX_UNSUPPORTED_CONTEXTS) unsupported.push(name.slice(0, 120));
            continue;
        }
        const context = isRecord(entry.context) ? entry.context : {};
        const cluster = asString(context.cluster) || null;
        contexts.push({
            name,
            cluster,
            server: cluster ? servers.get(cluster) ?? null : null,
            namespace: asString(context.namespace) || null,
            user: asString(context.user) || null
        });
    }
    contexts.sort((a, b) => a.name.localeCompare(b.name));
    const current = asString(value["current-context"]);
    return { contexts, currentContext: contexts.some((context) => context.name === current) ? current : null, unsupported };
}

export function parseClientVersion(value: unknown): string | null {
    const client = isRecord(value) ? value.clientVersion : null;
    return isRecord(client) ? asString(client.gitVersion) || null : null;
}

type StatusParts = {
    runner: K8sRunner;
    path: string | null;
    version: string | null;
    sudo: boolean;
    // `config view`: its output and exit status (null: not run).
    config: { output: string; code: number | null } | null;
    detectedAt: number;
};

export function buildStatus(parts: StatusParts): K8sStatus {
    const base = {
        runner: parts.runner,
        kubectl: parts.path ? { path: parts.path, version: parts.version } : null,
        sudo: parts.sudo,
        installUrl: K8S_INSTALL_URL,
        detectedAt: parts.detectedAt
    };
    const unavailable = (code: NonNullable<K8sStatus["problem"]>["code"], message: string) => ({
        ...base, available: false, problem: { code, message }, contexts: [], currentContext: null, unsupportedContexts: []
    });
    if (!parts.path) {
        return unavailable("KUBECTL_MISSING", parts.runner === "local"
            ? "kubectl was not found on this computer's PATH."
            : "kubectl was not found on the server (PATH of a non-interactive SSH session, /usr/local/bin and /snap/bin included).");
    }
    const config = parts.config;
    const parsed = config ? extractJson(config.output) : null;
    if (!config || config.code !== 0 || !isRecord(parsed)) {
        const message = config ? kubectlMessage({ stdout: config.output, stderr: config.output }) : "";
        return unavailable("KUBECONFIG_ERROR", message || "kubectl could not read its kubeconfig.");
    }
    const { contexts, currentContext, unsupported } = parseConfigView(parsed);
    if (!contexts.length) {
        return {
            ...unavailable("NO_CONTEXTS", unsupported.length
                ? "The kubeconfig only has contexts whose names ShellMind cannot pass to kubectl (blanks, quotes or shell characters)."
                : "kubectl has no kubeconfig contexts (~/.kube/config or $KUBECONFIG)."),
            unsupportedContexts: unsupported
        };
    }
    return { ...base, available: true, problem: null, contexts, currentContext, unsupportedContexts: unsupported };
}

export function parseSshDetection(output: string, detectedAt = Date.now()): K8sStatus {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new Error("The kubectl check was cut off before it finished.");
    const path = sections.get("path")?.trim() ?? "";
    const exit = (name: string) => {
        const value = Number.parseInt(sections.get(name)?.trim() ?? "", 10);
        return Number.isFinite(value) ? value : null;
    };
    const version = parseClientVersion(extractJson(sections.get("version") ?? ""));
    const own = sections.has("config") ? { output: sections.get("config") ?? "", code: exit("config-exit") } : null;
    const root = sections.has("sudo-config") ? { output: sections.get("sudo-config") ?? "", code: exit("sudo-exit") } : null;
    const parts = { runner: "ssh" as const, path: REMOTE_PATH.test(path) ? path : null, version, detectedAt };
    const mine = buildStatus({ ...parts, sudo: false, config: own });
    if (mine.available || !root) return mine;
    const viaSudo = buildStatus({ ...parts, sudo: true, config: root });
    return viaSudo.available ? viaSudo : mine;
}

export async function detectSsh(lease: SshLease, signal?: AbortSignal): Promise<K8sStatus> {
    const result = await runPosixScript(lease, SSH_DETECT_SCRIPT, { timeoutMs: DETECT_TIMEOUT_MS, signal, maxOutputBytes: 8 * 1024 * 1024 });
    return parseSshDetection(result.stdout);
}

export async function detectLocal(serverId: number, signal?: AbortSignal): Promise<K8sStatus> {
    const detectedAt = Date.now();
    const path = await resolveExecutable("kubectl", { env: localProcessEnv() });
    if (!path) return buildStatus({ runner: "local", path: null, version: null, sudo: false, config: null, detectedAt });
    const runner = localRunner(serverId, path);
    const options = { timeoutMs: DETECT_TIMEOUT_MS, signal, maxOutputBytes: 8 * 1024 * 1024 };
    const [version, config] = await Promise.all([
        runner.run(["version", "--client", "-o", "json"], options).catch(() => null),
        runner.run(["config", "view", "-o", "json"], options)
    ]);
    return buildStatus({
        runner: "local",
        path,
        version: version ? parseClientVersion(extractJson(version.stdout)) : null,
        sudo: false,
        config: { output: config.code === 0 ? config.stdout : `${config.stderr}\n${config.stdout}`, code: config.code },
        detectedAt
    });
}
