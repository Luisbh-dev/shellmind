import { AppError } from "../errors";
import type { KubectlResult } from "./runner";

// kubectl's failures as API errors with a stable code (the UI words them in
// the user's language) and kubectl's own message as the text. A cluster that
// refuses the request (RBAC) reads as "not allowed", not as a broken panel.
//
// K8S_AUTH_REQUIRED          no valid credentials: an expired token, or a
//                            credential plugin (aws eks get-token,
//                            gke-gcloud-auth-plugin, kubelogin) that needs a
//                            sign-in. HTTP 502, never 401: to the frontend a
//                            401 means ShellMind's own access token was
//                            refused, and it would drop it and lock the app.
// K8S_FORBIDDEN              RBAC refused the verb on that resource
// K8S_CONTEXT_NOT_FOUND      the kubeconfig has no such context
// K8S_CONTAINER_NOT_RUNNING  the container has not started (logs of a pod
//                            still initializing) or has stopped
// K8S_NOT_FOUND              the pod / workload / node does not exist (any more)
// K8S_UNREACHABLE            the API server cannot be reached
// K8S_TIMEOUT                kubectl did not answer in time (runner.ts)
// K8S_COMMAND_FAILED         anything else kubectl reported
// KUBECTL_MISSING            kubectl could not be started

const MAX_MESSAGE_CHARS = 2000;

const AUTH = /You must be logged in to the server|\bUnauthorized\b|the server has asked for the client to provide credentials|getting credentials: exec|exec plugin|gke-gcloud-auth-plugin|kubelogin|token (?:has )?expired|refresh token|could not get token|failed to refresh|Please run 'az login'|Error loading SSO Token|ExpiredToken/i;
const FORBIDDEN = /\bForbidden\b|forbidden:|is forbidden|cannot (?:get|list|watch|create|delete|patch|update) resource/i;
const CONTEXT = /context was not found for specified context|context "[^"]*" does not exist|no context exists with the name/i;
const NOT_RUNNING = /is waiting to start|container [^\n]* is not running|cannot exec into a container in a completed pod/i;
const NOT_FOUND = /\(NotFound\)|\bnot found\b/i;
const UNREACHABLE = /Unable to connect to the server|connection refused|no such host|i\/o timeout|context deadline exceeded|TLS handshake timeout|Client\.Timeout exceeded|dial tcp|connect: network is unreachable|was refused - did you specify the right host or port|couldn't get current server API group list/i;
const MISSING = /ENOENT|not found: kubectl|kubectl: (?:command )?not found|No such file or directory/i;

// The first lines of what kubectl printed, without its noise ("E1024 ...
// memcache.go" lines repeat the message that follows them).
export function kubectlMessage(result: Pick<KubectlResult, "stdout" | "stderr">): string {
    const lines = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const meaningful = lines.filter((line) => !/^[EWI]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ \S+\.go:\d+\]/.test(line));
    const text = (meaningful.length ? meaningful : lines).join("\n") || result.stdout.trim();
    return text.slice(0, MAX_MESSAGE_CHARS);
}

export function kubectlFailure(result: KubectlResult, fallback = "kubectl failed"): AppError {
    const message = kubectlMessage(result) || fallback;
    const details = { exitCode: result.code };
    if (result.code === null && MISSING.test(message)) return new AppError("KUBECTL_MISSING", message, 409, details);
    if (CONTEXT.test(message)) return new AppError("K8S_CONTEXT_NOT_FOUND", message, 404, details);
    if (AUTH.test(message)) return new AppError("K8S_AUTH_REQUIRED", message, 502, details);
    if (FORBIDDEN.test(message)) return new AppError("K8S_FORBIDDEN", message, 403, details);
    if (UNREACHABLE.test(message)) return new AppError("K8S_UNREACHABLE", message, 502, details);
    if (NOT_RUNNING.test(message)) return new AppError("K8S_CONTAINER_NOT_RUNNING", message, 409, details);
    if (NOT_FOUND.test(message)) return new AppError("K8S_NOT_FOUND", message, 404, details);
    return new AppError("K8S_COMMAND_FAILED", message, 502, details);
}

export class K8sInputError extends AppError {
    constructor(message: string) {
        super("K8S_INVALID_INPUT", message, 400);
        this.name = "K8sInputError";
    }
}
