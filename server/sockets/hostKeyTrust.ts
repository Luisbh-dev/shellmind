import type { TrustHostKeyPayload, TrustHostKeyResult } from "../../shared/terminal";
import { loadConnectionTarget, type SshTarget } from "../connections/target";
import { knownHostsRepo } from "../db/knownHostsRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { routeVia } from "../ssh/hostKeys";

const log = createLogger("terminal");

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const KEY_TYPE = /^[A-Za-z0-9@._-]{1,64}$/;

function parsePayload(payload: unknown): TrustHostKeyPayload | null {
    const input = (payload ?? {}) as Partial<Record<keyof TrustHostKeyPayload, unknown>>;
    const { serverId, host, port, keyType, expected, actual } = input;
    if (typeof serverId !== "number" || typeof host !== "string" || !host || host.length > 255) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof keyType !== "string" || !KEY_TYPE.test(keyType)) return null;
    if (typeof expected !== "string" || !FINGERPRINT.test(expected)) return null;
    if (typeof actual !== "string" || !FINGERPRINT.test(actual) || actual === expected) return null;
    return { serverId, host, port, keyType, expected, actual };
}

function refuse(code: string, error: string): TrustHostKeyResult {
    return { ok: false, code, error };
}

// The user compared a changed host key and trusts the new one. Only a host on
// the route to the saved server (the server or one of its jump hosts) is
// accepted, and the pinned key is swapped for exactly the key the user saw,
// in one step: no other connection can pin something else in between, and a
// third key presented later is a mismatch again.
export async function trustChangedHostKey(payload: unknown): Promise<TrustHostKeyResult> {
    const input = parsePayload(payload);
    if (!input) return refuse("INVALID_REQUEST", "The host key to trust is not valid.");

    let target: SshTarget;
    try {
        target = await loadConnectionTarget(input.serverId, "exec");
    } catch (err) {
        return refuse(err instanceof AppError ? err.code : "SERVER_NOT_FOUND", errorMessage(err));
    }
    let hop: SshTarget | null = target;
    while (hop && !(hop.host === input.host && hop.port === input.port)) hop = hop.jump;
    if (!hop) return refuse("NOT_ON_ROUTE", `${input.host}:${input.port} is not on the route to this server.`);

    // The pin of that host on its own route (through the hops before it).
    const pinned = await knownHostsRepo.replace(
        { host: input.host, port: input.port, via: routeVia(hop), key_type: input.keyType, fingerprint: input.actual },
        input.expected
    );
    if (pinned.fingerprint !== input.actual) {
        return refuse("HOST_KEY_CHANGED", "The pinned host key changed in the meantime; reconnect to compare the current keys.");
    }
    log.warn(`Host key of ${input.host}:${input.port} replaced at the user's request: ${input.expected} -> ${input.actual}`);
    return { ok: true };
}
