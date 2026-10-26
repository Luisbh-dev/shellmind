import type { K8sStatus } from "../../shared/k8s";
import { scopedPresetKey } from "../../shared/shells";
import { loadConnectionTarget, type LocalTarget, type SshTarget } from "../connections/target";
import { AppError } from "../errors";
import { localProcessEnv } from "../local/env";
import { envValue } from "../local/resolve";
import { createLogger } from "../logger";
import { sshPool, type SshLease } from "../ssh/pool";
import { detectLocal, detectSsh } from "./detect";
import { localRunner, sshRunner, type KubectlRunner } from "./runner";

// The kubectl of a saved server: on this machine for a local server with the
// kubectl preset, on the server for a Linux SSH server. What detection found
// is cached briefly per server (an edited server, or another KUBECONFIG, is
// detected again); "Check again" in the tab bypasses the cache.

const log = createLogger("k8s");

const STATUS_TTL_MS = 2 * 60_000;

type CacheEntry = { key: string; value: K8sStatus };
const cache = new Map<number, CacheEntry>();

export type K8sTarget = LocalTarget | SshTarget;

export class K8sUnsupportedError extends AppError {
    constructor(message: string) {
        super("K8S_UNSUPPORTED", message, 409);
        this.name = "K8sUnsupportedError";
    }
}

// The server, if ShellMind runs kubectl for it.
export async function loadK8sTarget(serverId: unknown): Promise<K8sTarget> {
    const target = await loadConnectionTarget(serverId, "terminal");
    if (target.kind === "local") {
        if (scopedPresetKey(target.cliPreset) !== "kubectl") {
            throw new K8sUnsupportedError("The Kubernetes tab of a local connection needs the kubectl CLI preset.");
        }
        return target;
    }
    if (target.kind !== "ssh") throw new K8sUnsupportedError("Kubernetes needs an SSH connection to a Linux server, or a local kubectl connection.");
    if (target.os === "windows") throw new K8sUnsupportedError("Kubernetes over SSH needs a Linux server.");
    return target;
}

// The kubeconfig this machine's kubectl reads (the user's environment, like PATH).
const localKey = () => `local:${envValue(localProcessEnv(), "KUBECONFIG") ?? ""}`;

function cached(serverId: number, key: string, refresh: boolean | undefined): K8sStatus | null {
    const entry = cache.get(serverId);
    if (refresh || !entry || entry.key !== key || Date.now() - entry.value.detectedAt > STATUS_TTL_MS) return null;
    return entry.value;
}

async function statusOverSsh(lease: SshLease, options: { refresh?: boolean; signal?: AbortSignal }): Promise<K8sStatus> {
    const key = `ssh:${lease.target.version}`;
    const hit = cached(lease.serverId, key, options.refresh);
    if (hit) return hit;
    const value = await detectSsh(lease, options.signal);
    cache.set(lease.serverId, { key, value });
    log.debug(`Server #${lease.serverId}: kubectl ${value.available ? `found (${value.contexts.length} contexts${value.sudo ? ", through sudo" : ""})` : `unavailable (${value.problem?.code})`}`);
    return value;
}

async function statusOnThisMachine(serverId: number, options: { refresh?: boolean; signal?: AbortSignal }): Promise<K8sStatus> {
    const key = localKey();
    const hit = cached(serverId, key, options.refresh);
    if (hit) return hit;
    const value = await detectLocal(serverId, options.signal);
    cache.set(serverId, { key, value });
    return value;
}

// GET .../k8s/status: never fails for a missing kubectl or kubeconfig (the
// status says so); a server that cannot be reached does.
export async function getK8sStatus(serverId: unknown, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<K8sStatus> {
    const target = await loadK8sTarget(serverId);
    if (target.kind === "local") return statusOnThisMachine(target.serverId, options);
    const lease = await sshPool.acquire(target.serverId);
    try {
        return await statusOverSsh(lease, options);
    } finally {
        lease.release();
    }
}

export type KubectlSession = {
    runner: KubectlRunner;
    status: K8sStatus;
    target: K8sTarget;
    // The pooled SSH connection it runs on (null: this machine).
    lease: SshLease | null;
    release: () => void;
};

function unavailable(status: K8sStatus): AppError {
    const problem = status.problem ?? { code: "KUBECTL_MISSING", message: "kubectl is not available." };
    return new AppError(problem.code === "KUBECTL_MISSING" ? "KUBECTL_MISSING" : "K8S_UNAVAILABLE", problem.message, 409, { problem: problem.code });
}

// A runner for the server's kubectl (release it when done). Fails with
// KUBECTL_MISSING / K8S_UNAVAILABLE when kubectl or a context is missing.
export async function openKubectl(serverId: unknown, options: { signal?: AbortSignal } = {}): Promise<KubectlSession> {
    const target = await loadK8sTarget(serverId);
    if (target.kind === "local") {
        const status = await statusOnThisMachine(target.serverId, options);
        if (!status.available || !status.kubectl?.path) throw unavailable(status);
        return { runner: localRunner(target.serverId, status.kubectl.path), status, target, lease: null, release: () => undefined };
    }
    const lease = await sshPool.acquire(target.serverId);
    try {
        const status = await statusOverSsh(lease, options);
        if (!status.available || !status.kubectl?.path) throw unavailable(status);
        return { runner: sshRunner(lease, status.kubectl.path, status.sudo), status, target, lease, release: () => lease.release() };
    } catch (err) {
        lease.release();
        throw err;
    }
}

// A context of the server's kubeconfig (K8S_CONTEXT_NOT_FOUND otherwise):
// requests name one, and only those kubectl listed are passed on.
export function requireKnownContext(status: K8sStatus, context: string): void {
    if (!status.contexts.some((entry) => entry.name === context)) {
        throw new AppError("K8S_CONTEXT_NOT_FOUND", `The kubeconfig has no context "${context}". Check again to read it anew.`, 404, { context });
    }
}

// The kubeconfig changed (use-context): detect it again next time.
export function forgetK8sStatus(serverId: number): void {
    cache.delete(serverId);
}

// For tests: forget what detection found.
export function clearK8sStatusCache(): void {
    cache.clear();
}
