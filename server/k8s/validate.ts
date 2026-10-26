import {
    K8S_ALL_NAMESPACES,
    POD_LOG_MAX_TAIL,
    isValidK8sContainer,
    isValidK8sContext,
    isValidK8sName,
    isValidK8sNamespace,
    type PodLogSource,
    type PodTerminalAttach
} from "../../shared/k8s";
import { AppError } from "../errors";
import { isRecord } from "../ops/remote";
import { K8sInputError } from "./errors";

// Request values, checked before any of them becomes a kubectl argument.

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function requireContext(value: unknown): string {
    const context = text(value);
    if (!isValidK8sContext(context)) throw new K8sInputError("Choose a kubeconfig context (names with blanks, quotes or shell characters are not supported).");
    return context;
}

export function requireNamespace(value: unknown): string {
    const namespace = text(value);
    if (!isValidK8sNamespace(namespace)) throw new K8sInputError("Not a valid namespace name (lowercase letters, digits and '-').");
    return namespace;
}

// A namespace, or K8S_ALL_NAMESPACES.
export function requireNamespaceScope(value: unknown): string {
    return text(value) === K8S_ALL_NAMESPACES ? K8S_ALL_NAMESPACES : requireNamespace(value);
}

export function requireName(value: unknown, what: string): string {
    const name = text(value);
    if (!isValidK8sName(name)) throw new K8sInputError(`Not a valid ${what} name (lowercase letters, digits, '-' and '.').`);
    return name;
}

export function requireContainer(value: unknown): string {
    const name = text(value);
    if (!isValidK8sContainer(name)) throw new K8sInputError("Not a valid container name (lowercase letters, digits and '-').");
    return name;
}

// `-n <namespace>`, or every namespace.
export function namespaceArgs(scope: string): string[] {
    return scope === K8S_ALL_NAMESPACES ? ["--all-namespaces"] : ["-n", scope];
}

export const DEFAULT_LOG_TAIL = 100;

export function parsePodLogSource(value: unknown): PodLogSource {
    const source = isRecord(value) ? value : {};
    const tail = typeof source.tail === "number" && Number.isInteger(source.tail) ? source.tail : DEFAULT_LOG_TAIL;
    if (tail < 0 || tail > POD_LOG_MAX_TAIL) throw new K8sInputError(`Show between 0 and ${POD_LOG_MAX_TAIL} lines of backlog.`);
    const previous = source.previous === true;
    return {
        kind: "pod",
        context: requireContext(source.context),
        namespace: requireNamespace(source.namespace),
        pod: requireName(source.pod, "pod"),
        container: requireContainer(source.container),
        ...(previous ? { previous: true } : {}),
        tail,
        // The previous instance has ended: there is nothing to follow.
        follow: source.follow !== false && !previous,
        timestamps: source.timestamps !== false
    };
}

// StartSshPayload.attach of kind "pod" (INVALID_ATTACH, like a container's).
export function parsePodAttach(value: unknown): PodTerminalAttach {
    try {
        if (!isRecord(value) || value.kind !== "pod") throw new K8sInputError("Unknown kind of terminal attachment.");
        return {
            kind: "pod",
            context: requireContext(value.context),
            namespace: requireNamespace(value.namespace),
            pod: requireName(value.pod, "pod"),
            container: requireContainer(value.container)
        };
    } catch (err) {
        throw err instanceof K8sInputError ? new AppError("INVALID_ATTACH", err.message, 400) : err;
    }
}
