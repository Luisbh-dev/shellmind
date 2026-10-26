import type { InstallEvent, InstallResult, RemoveResult } from "../../shared/identities";
import type { AuditInput } from "../../shared/types";
import { loadSshTarget, readPrivateKeyFile, type SshTarget } from "../connections/target";
import { recordAudit } from "../db/auditRepo";
import { identitiesRepo, type IdentityRecord } from "../db/identitiesRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { connectionError } from "../ssh/connectionErrors";
import { ExecAbortedError } from "../ssh/exec";
import { routeVia } from "../ssh/hostKeys";
import { SshPool, sshPool, type SshLease } from "../ssh/pool";
import { IdentityKeyMissingError, installOnLease, removeOnLease, type InstallOutcome } from "./install";
import { describePublicKey, generateEd25519, publicKeyOf, type PublicKeyInfo } from "./keys";

// Installing an identity's public key on servers, and rotating its key:
// a few servers at a time, each through its pooled connection (the
// credentials it signs in with now), then a check that the key alone signs in
// on a separate connection that offers nothing else. Every server gets an
// audit entry (source "identity") with the key's fingerprint, never a secret.

const log = createLogger("identities");

export const INSTALL_CONCURRENCY = 4;
export const INSTALL_TIMEOUT_MS = 30_000;

export type KeyPair = { privateKey: string; passphrase: string | null; info: PublicKeyInfo };

export type VerifyOutcome = { ok: true } | { ok: false; code: string; message: string };

export type InstallDeps = {
    acquire: (serverId: number) => Promise<SshLease>;
    // Signs in to the lease's server with the key only.
    verify: (target: SshTarget, key: KeyPair) => Promise<VerifyOutcome>;
    record: (entry: AuditInput) => Promise<unknown>;
    // The remote account a server signs in to (its authorized_keys file).
    accountOf: (serverId: number) => Promise<string>;
    install: typeof installOnLease;
    remove: typeof removeOnLease;
};

// Route, host, port and user: saved servers with the same one share an
// authorized_keys file.
async function accountOf(serverId: number): Promise<string> {
    try {
        const target = await loadSshTarget(serverId);
        return JSON.stringify([routeVia(target), target.host, target.port, target.username]);
    } catch {
        // It fails on its own when installed.
        return `#${serverId}`;
    }
}

// A connection outside the shared pool whose target is the server's with the
// key as its only credential (no password, no agent, no keyboard-interactive).
// Host keys are checked against the pinned ones like any connection.
export async function verifyKeyLogin(target: SshTarget, key: KeyPair): Promise<VerifyOutcome> {
    const probe = new SshPool({
        idleTimeoutMs: 1000,
        loadTarget: async (id) => id === target.serverId
            ? {
                ...target,
                password: undefined,
                agent: undefined,
                agentForward: false,
                privateKey: key.privateKey,
                passphrase: key.passphrase ?? undefined,
                version: `verify:${target.version}`
            }
            : loadSshTarget(id)
    });
    try {
        const lease = await probe.acquire(target.serverId);
        lease.release();
        return { ok: true };
    } catch (err) {
        const { code, message } = connectionError(err);
        return { ok: false, code, message };
    } finally {
        probe.closeAll();
    }
}

const defaultDeps: InstallDeps = {
    acquire: (serverId) => sshPool.acquire(serverId),
    verify: verifyKeyLogin,
    record: recordAudit,
    accountOf,
    install: installOnLease,
    remove: removeOnLease
};

// The identity's key pair (its stored key or its key file).
export async function identityKeyPair(identity: IdentityRecord): Promise<KeyPair> {
    if (identity.unreadable.includes("privateKey")) {
        throw new AppError("SECRET_UNREADABLE", `The private key of "${identity.name}" cannot be decrypted with the current data key. Enter it again.`, 409);
    }
    const privateKey = identity.private_key_path ? await readPrivateKeyFile(identity.private_key_path) : identity.privateKey;
    if (!privateKey) throw new IdentityKeyMissingError(`"${identity.name}" has no private key: generate or add one first.`);
    const comment = describePublicKey(identity.public_key)?.publicKey.split(" ")[2] ?? `shellmind:${identity.name}`;
    return { privateKey, passphrase: identity.passphrase, info: publicKeyOf(privateKey, identity.passphrase, comment) };
}

type Server = { serverId: number; name: string };

type InstallRun = {
    servers: Server[];
    key: KeyPair;
    identity: { id: number; name: string };
    signal: AbortSignal;
    emit: (event: InstallEvent) => void;
    // "install" or "rotate" (audit meta).
    action: string;
    concurrency?: number;
};

function failed(server: Server, err: unknown): InstallResult {
    if (err instanceof ExecAbortedError) return { ...server, status: "failed", errorCode: "CANCELLED", error: "Cancelled." };
    const { code, message } = connectionError(err);
    return { ...server, status: "failed", errorCode: code, error: message };
}

async function installOne(server: Server, run: InstallRun, deps: InstallDeps): Promise<InstallResult> {
    let lease: SshLease;
    try {
        run.emit({ type: "progress", serverId: server.serverId, phase: "installing" });
        lease = await deps.acquire(server.serverId);
    } catch (err) {
        return failed(server, err);
    }
    let outcome: InstallOutcome;
    const target = lease.target;
    try {
        outcome = await deps.install(lease, run.key.info, { timeoutMs: INSTALL_TIMEOUT_MS, signal: run.signal });
    } catch (err) {
        return failed(server, err);
    } finally {
        lease.release();
    }
    if (run.signal.aborted) return { ...server, status: outcome.status, file: outcome.file ?? undefined, warnings: outcome.warnings };

    run.emit({ type: "progress", serverId: server.serverId, phase: "verifying" });
    const verified = await deps.verify(target, run.key);
    return {
        ...server,
        status: outcome.status,
        verified: verified.ok,
        ...(verified.ok ? {} : { errorCode: verified.code, error: verified.message }),
        file: outcome.file ?? undefined,
        ...(outcome.warnings.length ? { warnings: outcome.warnings } : {})
    };
}

async function audit(result: InstallResult, run: InstallRun, deps: InstallDeps): Promise<void> {
    try {
        await deps.record({
            serverId: result.serverId,
            source: "identity",
            command: `${run.action === "rotate" ? "rotate key: install" : "install"} public key ${run.key.info.type} ${run.key.info.fingerprint} (identity "${run.identity.name}")`,
            exitCode: result.status === "failed" ? 1 : 0,
            meta: {
                identityId: run.identity.id,
                action: run.action,
                fingerprint: run.key.info.fingerprint,
                status: result.status,
                verified: result.verified ?? null,
                ...(result.file ? { file: result.file } : {}),
                ...(result.errorCode ? { error: result.errorCode } : {})
            }
        });
    } catch (err) {
        log.warn(`Could not record the key install on server #${result.serverId} in the audit log: ${errorMessage(err)}`);
    }
}

// Installs on every server, INSTALL_CONCURRENCY at a time. Servers that sign
// in to the same account go one after the other (the second finds the key
// the first added) instead of appending to one file at once. Servers not
// started when the run is cancelled are reported as cancelled.
export async function installKey(run: InstallRun, deps: InstallDeps = defaultDeps): Promise<InstallResult[]> {
    const groups = new Map<string, Server[]>();
    for (const server of run.servers) {
        const account = await deps.accountOf(server.serverId);
        groups.set(account, [...(groups.get(account) ?? []), server]);
    }
    const queue = [...groups.values()];
    const results: InstallResult[] = [];
    const worker = async () => {
        for (let group = queue.shift(); group; group = queue.shift()) {
            for (const server of group) {
                const result = run.signal.aborted
                    ? { ...server, status: "failed" as const, errorCode: "CANCELLED", error: "Cancelled." }
                    : await installOne(server, run, deps);
                if (result.errorCode !== "CANCELLED") await audit(result, run, deps);
                results.push(result);
                run.emit({ type: "result", result });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(run.concurrency ?? INSTALL_CONCURRENCY, queue.length) }, worker));
    return results;
}

// Only a stored key can be rotated (ShellMind does not write key files).
export function assertRotatable(identity: IdentityRecord): void {
    if (identity.private_key_path) throw new AppError("IDENTITY_KEY_FILE", `"${identity.name}" reads its key from a file; replace that file to rotate it.`, 409);
    if (!identity.privateKey) throw new IdentityKeyMissingError(`"${identity.name}" has no stored private key to rotate.`);
}

// The previous key of a rotated identity, taken out of the authorized_keys
// of its servers, signing in with the new key (the pool was told to drop
// the old one). Servers that sign in to the same account go one after the
// other (the second finds it gone). Each one is audited.
async function removePreviousKey(
    previous: PublicKeyInfo,
    run: { servers: Server[]; identity: { id: number; name: string }; signal: AbortSignal; emit: (event: InstallEvent) => void },
    deps: InstallDeps
): Promise<RemoveResult[]> {
    const groups = new Map<string, Server[]>();
    for (const server of run.servers) {
        const account = await deps.accountOf(server.serverId);
        groups.set(account, [...(groups.get(account) ?? []), server]);
    }
    const queue = [...groups.values()];
    const results: RemoveResult[] = [];
    const removeOne = async (server: Server): Promise<RemoveResult> => {
        if (run.signal.aborted) return { serverId: server.serverId, status: "failed", errorCode: "CANCELLED", error: "Cancelled." };
        let lease: SshLease;
        try {
            lease = await deps.acquire(server.serverId);
        } catch (err) {
            return { serverId: server.serverId, ...removalFailure(err) };
        }
        try {
            const outcome = await deps.remove(lease, previous, { timeoutMs: INSTALL_TIMEOUT_MS, signal: run.signal });
            return { serverId: server.serverId, status: outcome.status, removed: outcome.removed, ...(outcome.file ? { file: outcome.file } : {}) };
        } catch (err) {
            return { serverId: server.serverId, ...removalFailure(err) };
        } finally {
            lease.release();
        }
    };
    const worker = async () => {
        for (let group = queue.shift(); group; group = queue.shift()) {
            for (const server of group) {
                const result = await removeOne(server);
                if (result.errorCode !== "CANCELLED") {
                    try {
                        await deps.record({
                            serverId: server.serverId,
                            source: "identity",
                            command: `rotate key: remove previous public key ${previous.type} ${previous.fingerprint} (identity "${run.identity.name}")`,
                            exitCode: result.status === "failed" ? 1 : 0,
                            meta: {
                                identityId: run.identity.id,
                                action: "rotate-remove",
                                fingerprint: previous.fingerprint,
                                status: result.status,
                                ...(result.removed ? { removed: result.removed } : {}),
                                ...(result.file ? { file: result.file } : {}),
                                ...(result.errorCode ? { error: result.errorCode } : {})
                            }
                        });
                    } catch (err) {
                        log.warn(`Could not record the key removal on server #${server.serverId} in the audit log: ${errorMessage(err)}`);
                    }
                }
                results.push(result);
                run.emit({ type: "removed", result });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(INSTALL_CONCURRENCY, queue.length) }, worker));
    return results;
}

function removalFailure(err: unknown): Omit<RemoveResult, "serverId"> {
    if (err instanceof ExecAbortedError) return { status: "failed", errorCode: "CANCELLED", error: "Cancelled." };
    const { code, message } = connectionError(err);
    return { status: "failed", errorCode: code, error: message };
}

// Rotation: a new ed25519 pair is installed on every server using the
// identity (signing in with the current key) and checked; the stored key is
// replaced only when all of them passed, or with `force`. Then, unless told
// otherwise (`removeOld` false: other people or tools still use it) and only
// when every server passed, the previous key is taken out of their
// authorized_keys: a rotation usually answers a key that leaked.
export async function rotateKey(
    identity: IdentityRecord,
    options: { passphrase: string | null; force: boolean; removeOld: boolean; servers: Server[]; signal: AbortSignal; emit: (event: InstallEvent) => void },
    deps: InstallDeps = defaultDeps
): Promise<{ replaced: boolean; results: InstallResult[]; removed: RemoveResult[]; fingerprint: string }> {
    assertRotatable(identity);
    const previous = describePublicKey(identity.public_key);
    const comment = previous?.publicKey.split(" ")[2] ?? `shellmind:${identity.name}`;
    const pair = generateEd25519(comment, options.passphrase ?? undefined);
    const key: KeyPair = { privateKey: pair.privateKey, passphrase: options.passphrase, info: pair };
    options.emit({ type: "start", servers: options.servers, fingerprint: pair.fingerprint });

    const results = await installKey({ servers: options.servers, key, identity, signal: options.signal, emit: options.emit, action: "rotate" }, deps);
    const passed = results.every((result) => result.status !== "failed" && result.verified === true);
    const replaced = !options.signal.aborted && (passed || options.force)
        && await identitiesRepo.replaceKey(identity.id, pair.privateKey, options.passphrase, pair.publicKey);
    if (replaced) {
        for (const server of options.servers) sshPool.invalidate(server.serverId);
        try {
            await deps.record({
                serverId: null,
                source: "identity",
                command: `rotate key of identity "${identity.name}" to ${pair.type} ${pair.fingerprint}`,
                exitCode: passed ? 0 : 1,
                meta: { identityId: identity.id, action: "rotate", fingerprint: pair.fingerprint, servers: options.servers.length, forced: !passed }
            });
        } catch (err) {
            log.warn(`Could not record the key rotation in the audit log: ${errorMessage(err)}`);
        }
    }
    options.emit({ type: "rotated", replaced, fingerprint: replaced ? pair.fingerprint : null });
    const removed = replaced && passed && options.removeOld && previous && previous.blob !== pair.blob && !options.signal.aborted
        ? await removePreviousKey(previous, { servers: options.servers, identity, signal: options.signal, emit: options.emit }, deps)
        : [];
    return { replaced, results, removed, fingerprint: pair.fingerprint };
}
