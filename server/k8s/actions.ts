import {
    K8S_MAX_REPLICAS,
    K8S_RESTARTABLE_KINDS,
    K8S_SCALABLE_KINDS,
    isK8sWorkloadKind,
    type K8sAction,
    type K8sActionResult,
    type K8sWorkloadKind
} from "../../shared/k8s";
import { recordAudit } from "../db/auditRepo";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import { kubectlFailure, kubectlMessage, K8sInputError } from "./errors";
import type { KubectlResult, KubectlRunner } from "./runner";
import { contextArgs } from "./service";

const log = createLogger("k8s");

// The state-changing commands of the Kubernetes tab, built from validated
// names before anything runs. Every attempt lands in the audit log (source
// "ops", meta.kind "k8s"), failures and timeouts included.

const ACTION_TIMEOUT_MS = 60_000;
const AUDIT_ERROR_CHARS = 500;

export type PreparedK8sAction = {
    args: string[];
    meta: {
        kind: "k8s";
        action: K8sAction;
        target: string;
        context: string;
        namespace?: string;
        workload?: K8sWorkloadKind;
        replicas?: number;
    };
};

export function requireWorkloadKind(value: string, allowed: readonly K8sWorkloadKind[], verb: string): K8sWorkloadKind {
    if (!isK8sWorkloadKind(value) || !allowed.includes(value)) {
        const kinds = allowed.map((kind) => `${kind}s`);
        const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}` : kinds[0];
        throw new K8sInputError(`Only ${list} can be ${verb}.`);
    }
    return value;
}

export function requireReplicas(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > K8S_MAX_REPLICAS) {
        throw new K8sInputError(`Enter a number of replicas between 0 and ${K8S_MAX_REPLICAS}.`);
    }
    return value;
}

export function prepareRestart(context: string, namespace: string, kind: string, name: string): PreparedK8sAction {
    const workload = requireWorkloadKind(kind, K8S_RESTARTABLE_KINDS, "restarted");
    return {
        args: [...contextArgs(context), "-n", namespace, "rollout", "restart", `${workload}/${name}`],
        meta: { kind: "k8s", action: "restart", target: name, context, namespace, workload }
    };
}

export function prepareScale(context: string, namespace: string, kind: string, name: string, replicas: unknown): PreparedK8sAction {
    const workload = requireWorkloadKind(kind, K8S_SCALABLE_KINDS, "scaled");
    const count = requireReplicas(replicas);
    return {
        args: [...contextArgs(context), "-n", namespace, "scale", `${workload}/${name}`, `--replicas=${count}`],
        meta: { kind: "k8s", action: "scale", target: name, context, namespace, workload, replicas: count }
    };
}

// --wait=false: the answer comes once the API server accepted the deletion,
// not after the pod's grace period.
export function prepareDeletePod(context: string, namespace: string, pod: string): PreparedK8sAction {
    return {
        args: [...contextArgs(context), "-n", namespace, "delete", "pod", pod, "--wait=false"],
        meta: { kind: "k8s", action: "delete-pod", target: pod, context, namespace }
    };
}

export function prepareCordon(context: string, node: string, action: string): PreparedK8sAction {
    if (action !== "cordon" && action !== "uncordon") throw new K8sInputError("A node can be cordoned or uncordoned.");
    return { args: [...contextArgs(context), action, node], meta: { kind: "k8s", action, target: node, context } };
}

// The only command that changes the kubeconfig, and only when asked.
export function prepareUseContext(context: string): PreparedK8sAction {
    return { args: ["config", "use-context", context], meta: { kind: "k8s", action: "use-context", target: context, context } };
}

// The command as the audit log records it: without the request timeout,
// which is ShellMind's, not the user's.
function auditCommand(runner: KubectlRunner, action: PreparedK8sAction): string {
    return runner.display(action.args.filter((arg) => !arg.startsWith("--request-timeout=")));
}

export async function performK8sAction(runner: KubectlRunner, action: PreparedK8sAction, signal?: AbortSignal): Promise<K8sActionResult> {
    const command = auditCommand(runner, action);
    let result: KubectlResult;
    try {
        result = await runner.run(action.args, { timeoutMs: ACTION_TIMEOUT_MS, signal });
    } catch (err) {
        await audit(runner.serverId, command, action, null, { error: errorMessage(err).slice(0, AUDIT_ERROR_CHARS) });
        throw err;
    }
    await audit(runner.serverId, command, action, result.code, result.code === 0 ? {} : { error: kubectlMessage(result).slice(0, AUDIT_ERROR_CHARS) });
    if (result.code !== 0) throw kubectlFailure(result, `${action.meta.action} failed`);
    return { ok: true, command, output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") };
}

async function audit(serverId: number, command: string, action: PreparedK8sAction, exitCode: number | null, extra: Record<string, unknown>): Promise<void> {
    try {
        await recordAudit({ serverId, source: "ops", command, exitCode, meta: { ...action.meta, ...extra } });
    } catch (err) {
        log.error(`Could not record "${command}" in the audit log:`, err);
    }
}
