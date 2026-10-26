import fs from "fs/promises";
import os from "os";
import path from "path";
import { CLI_PRESET_KEYS, normalizeCliPreset } from "../../shared/cliPresets";
import { MAX_JUMP_HOPS } from "../../shared/hostRoutes";
import { effectivePort } from "../../shared/ports";
import type { ConnectionPurpose } from "../../shared/types";
import { AppError, errorMessage } from "../errors";
import { identitiesRepo, type IdentityRecord, type IdentitySecretColumn } from "../db/identitiesRepo";
import { normalizeHost, serversRepo, type SecretColumn, type ServerRecord } from "../db/serversRepo";
import { locateAgent, type AgentLocation } from "../ssh/agent";

// Connection targets are built only from the saved server row: the client
// names a server id and a purpose, never a host, port, type or user, so stored
// credentials can only ever reach the host they were saved for.
//
// W7-S2 identities (Settings > Keychain): an SSH server with an identity takes
// the credentials it leaves empty from it. A field saved on the server wins
// whenever it is set:
//   username     the server's, else the identity's, else "root" ("" for RDP)
//   private key  the server's key file or pasted key with the server's
//                passphrase, else the identity's key file or stored key with
//                the identity's passphrase (a key never gets the other's)
//   password     the server's, else the identity's; on a Windows server also
//                the Remote Desktop password
//   SSH agent    when the identity signs in with it and an agent is found
//                (server/ssh/agent.ts); ssh2 tries the password, then the
//                key, then the agent's keys
// A secret that cannot be decrypted counts as not set. Agent forwarding is the
// server's own setting and needs the agent. Editing the identity changes the
// target's version, so pooled connections are not reused with the old values.

export { MAX_JUMP_HOPS };

export type SshTarget = {
    kind: "ssh";
    serverId: number;
    name: string;
    os: "linux" | "windows";
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    // W7-S2: the identity filling what the row leaves empty, the SSH agent
    // to sign in with (a socket / pipe path or "pageant") and whether its
    // interactive terminal shells forward the agent.
    identityId: number | null;
    agent?: string;
    agentForward: boolean;
    // Reached through this server first (ProxyJump), if any.
    jump: SshTarget | null;
    // Changes whenever this row, its identity or a row of its jump chain is edited.
    version: string;
};

export type FtpTarget = {
    kind: "ftp";
    serverId: number;
    name: string;
    host: string;
    port: number;
    username: string;
    password?: string;
};

export type S3Target = {
    kind: "s3";
    serverId: number;
    name: string;
    provider: string | null;
    bucket: string;
    region: string | null;
    endpoint: string | null;
    accessKey: string;
    secretKey: string;
};

export type LocalTarget = {
    kind: "local";
    serverId: number;
    name: string;
    command: string | null;
    cwd: string | null;
    initialCommand: string | null;
    cliPreset: string | null;
};

export type RdpTarget = {
    kind: "rdp";
    serverId: number;
    name: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    domain?: string;
};

export type SessionTarget = SshTarget | FtpTarget | S3Target | LocalTarget;
export type ConnectionTarget = SessionTarget | RdpTarget;

type TargetErrorCode = "INVALID_SERVER_ID" | "SERVER_NOT_FOUND" | "UNSUPPORTED_PURPOSE" | "JUMP_HOST" | "PRIVATE_KEY_FILE" | "SECRET_UNREADABLE"
    // slice V4b: a local server saved (before 1.0 validated presets) with a preset ShellMind does not know.
    | "UNKNOWN_CLI_PRESET"
    // W7-S2: the identity row is gone / nothing but the agent to sign in with, and no agent.
    | "IDENTITY" | "AGENT_UNAVAILABLE";

const TARGET_ERROR_STATUS: Partial<Record<TargetErrorCode, number>> = { SERVER_NOT_FOUND: 404, SECRET_UNREADABLE: 409 };

export class ConnectionTargetError extends AppError {
    constructor(code: TargetErrorCode, message: string) {
        super(code, message, TARGET_ERROR_STATUS[code] ?? 400);
        this.name = "ConnectionTargetError";
    }
}

// Private keys are a few KiB; anything larger is not one.
export const MAX_PRIVATE_KEY_FILE_BYTES = 64 * 1024;

const SECRET_LABELS: Record<SecretColumn, string> = {
    password: "password",
    privateKey: "private key",
    passphrase: "key passphrase",
    s3_secret_key: "S3 secret key"
};

// Fails when a credential the connection depends on was saved with another
// data key (stale ones it does not need are simply left out).
function requireReadable(record: ServerRecord, columns: SecretColumn[], identity?: IdentityRecord | null): void {
    const missing = columns.filter((column) => record.unreadable.includes(column));
    if (missing.length > 0) {
        throw new ConnectionTargetError(
            "SECRET_UNREADABLE",
            `The saved ${missing.map((column) => SECRET_LABELS[column]).join(" and ")} of "${record.name}" cannot be decrypted with the current data key. Enter ${missing.length > 1 ? "them" : "it"} again in the connection settings.`
        );
    }
    const missingInIdentity = identity ? columns.filter((column): column is IdentitySecretColumn => (identity.unreadable as string[]).includes(column)) : [];
    if (identity && missingInIdentity.length > 0) {
        throw new ConnectionTargetError(
            "SECRET_UNREADABLE",
            `The saved ${missingInIdentity.map((column) => SECRET_LABELS[column]).join(" and ")} of the identity "${identity.name}" (used by "${record.name}") cannot be decrypted with the current data key. Enter ${missingInIdentity.length > 1 ? "them" : "it"} again in Settings > Keychain.`
        );
    }
}

async function loadIdentity(record: ServerRecord): Promise<IdentityRecord | null> {
    if (record.identity_id === null || record.identity_id === undefined) return null;
    const identity = await identitiesRepo.getRecord(record.identity_id);
    if (!identity) throw new ConnectionTargetError("IDENTITY", `The identity of "${record.name}" no longer exists. Edit the connection.`);
    return identity;
}

const AGENT_REASONS: Record<Extract<AgentLocation, { path: null }>["reason"], string> = {
    disabled: "SHELLMIND_SSH_AGENT is set to off",
    "remote-backend": "the backend does not run on this computer (set SHELLMIND_SSH_AGENT to use the agent of the machine it runs on)",
    "not-found": "SSH_AUTH_SOCK is not set"
};

export function parseServerId(value: unknown): number {
    const id = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        throw new ConnectionTargetError("INVALID_SERVER_ID", "A saved server is required for this connection.");
    }
    return id;
}

export function expandHome(file: string): string {
    if (file === "~") return os.homedir();
    if (file.startsWith("~/") || file.startsWith("~\\")) return path.join(os.homedir(), file.slice(2));
    return file;
}

async function loadRecord(id: number): Promise<ServerRecord> {
    const record = await serversRepo.getRecord(id);
    if (!record) throw new ConnectionTargetError("SERVER_NOT_FOUND", `Server #${id} does not exist (it may have been deleted).`);
    return record;
}

export async function readPrivateKeyFile(file: string): Promise<string> {
    const resolved = expandHome(file);
    const unreadable = (reason: string) => new ConnectionTargetError("PRIVATE_KEY_FILE", `Cannot read the private key file ${resolved}: ${reason}`);
    const reasonOf = (err: unknown) => (err as NodeJS.ErrnoException).code || errorMessage(err);
    try {
        // Checked first: reading a FIFO or a device would block or never end.
        const info = await fs.stat(resolved);
        if (!info.isFile()) throw unreadable("not a regular file");
        if (info.size > MAX_PRIVATE_KEY_FILE_BYTES) throw unreadable(`larger than ${MAX_PRIVATE_KEY_FILE_BYTES / 1024} KiB, not a private key`);
        return await fs.readFile(resolved, "utf8");
    } catch (err) {
        throw err instanceof ConnectionTargetError ? err : unreadable(reasonOf(err));
    }
}

function unsupported(record: ServerRecord, purpose: ConnectionPurpose): ConnectionTargetError {
    return new ConnectionTargetError("UNSUPPORTED_PURPOSE", `A ${record.type} server does not support ${purpose} connections.`);
}

function port(record: ServerRecord, purpose: ConnectionPurpose): number {
    const resolved = effectivePort(record, purpose);
    if (resolved === null) throw unsupported(record, purpose);
    return resolved;
}

async function buildSshTarget(record: ServerRecord, chain: number[]): Promise<SshTarget> {
    if (record.type !== "linux" && record.type !== "windows") throw unsupported(record, "exec");

    let jump: SshTarget | null = null;
    if (record.jump_server_id !== null && record.jump_server_id !== undefined) {
        const jumpId = record.jump_server_id;
        if (jumpId === record.id || chain.includes(jumpId)) {
            throw new ConnectionTargetError("JUMP_HOST", `The jump host chain of "${record.name}" loops back on itself.`);
        }
        if (chain.length >= MAX_JUMP_HOPS) {
            throw new ConnectionTargetError("JUMP_HOST", `The jump host chain of "${record.name}" is longer than ${MAX_JUMP_HOPS} hops.`);
        }
        const jumpRecord = await serversRepo.getRecord(jumpId);
        if (!jumpRecord) throw new ConnectionTargetError("JUMP_HOST", `The jump server of "${record.name}" no longer exists.`);
        if (jumpRecord.type !== "linux" && jumpRecord.type !== "windows") {
            throw new ConnectionTargetError("JUMP_HOST", `The jump server "${jumpRecord.name}" is not an SSH server.`);
        }
        jump = await buildSshTarget(jumpRecord, [...chain, record.id]);
    }

    const identity = await loadIdentity(record);
    // The server's own key with its own passphrase, else the identity's pair.
    const ownKey = record.private_key_path ? await readPrivateKeyFile(record.private_key_path) : record.privateKey;
    const identityKey = !ownKey && identity
        ? identity.private_key_path ? await readPrivateKeyFile(identity.private_key_path) : identity.privateKey
        : null;
    const privateKey = ownKey ?? identityKey;
    const passphrase = identityKey ? identity?.passphrase : record.passphrase;
    const password = record.password ?? identity?.password ?? null;
    const agent = identity?.use_agent ? locateAgent() : null;
    const agentPath = agent?.path ?? undefined;

    // Nothing left to authenticate with: say why instead of failing auth.
    if (!privateKey && !password && !agentPath) {
        requireReadable(record, ["password", "privateKey"], identity);
        if (agent && agent.path === null) {
            throw new ConnectionTargetError(
                "AGENT_UNAVAILABLE",
                `"${record.name}" signs in with the SSH agent (identity "${identity?.name}"), but no agent is available: ${AGENT_REASONS[agent.reason]}.`
            );
        }
    }

    return {
        kind: "ssh",
        serverId: record.id,
        name: record.name,
        os: record.type,
        host: normalizeHost(record.ip),
        port: port(record, "terminal"),
        username: record.username?.trim() || identity?.username?.trim() || "root",
        password: password ?? undefined,
        privateKey: privateKey ?? undefined,
        passphrase: passphrase ?? undefined,
        identityId: identity?.id ?? null,
        agent: agentPath,
        agentForward: Boolean(record.agent_forward) && agentPath !== undefined,
        jump,
        version: `${record.id}@${record.updated_at ?? 0}${identity ? `~${identity.id}@${identity.updated_at}` : ""}${agentPath ? "+agent" : ""}${jump ? `>${jump.version}` : ""}`
    };
}

// The SSH endpoint of a saved Linux/Windows server, with its jump chain.
export async function loadSshTarget(serverId: unknown): Promise<SshTarget> {
    return buildSshTarget(await loadRecord(parseServerId(serverId)), []);
}

// RDP `{ password: false }`: without the saved password (the embedded client
// asks for it, so one that cannot be decrypted is no reason to refuse).
export type RdpTargetOptions = { password?: boolean };

export function loadConnectionTarget(serverId: unknown, purpose: "rdp", options?: RdpTargetOptions): Promise<RdpTarget>;
export function loadConnectionTarget(serverId: unknown, purpose: "status" | "exec"): Promise<SshTarget>;
export function loadConnectionTarget(serverId: unknown, purpose: "terminal" | "files"): Promise<SessionTarget>;
export function loadConnectionTarget(serverId: unknown, purpose: ConnectionPurpose): Promise<ConnectionTarget>;
export async function loadConnectionTarget(serverId: unknown, purpose: ConnectionPurpose, options: RdpTargetOptions = {}): Promise<ConnectionTarget> {
    const record = await loadRecord(parseServerId(serverId));
    const base = { serverId: record.id, name: record.name };

    switch (record.type) {
        case "linux":
            if (purpose === "rdp") throw unsupported(record, purpose);
            return buildSshTarget(record, []);

        case "windows": {
            if (purpose !== "rdp") return buildSshTarget(record, []);
            const identity = await loadIdentity(record);
            const password = options.password === false ? null : record.password ?? identity?.password ?? null;
            if (!password && options.password !== false) requireReadable(record, ["password"], identity);
            return {
                ...base,
                kind: "rdp",
                host: normalizeHost(record.ip),
                port: port(record, "rdp"),
                username: record.username?.trim() || identity?.username?.trim() || "",
                password: password ?? undefined,
                domain: record.domain?.trim() || undefined
            };
        }

        case "ftp":
            if (purpose !== "terminal" && purpose !== "files") throw unsupported(record, purpose);
            requireReadable(record, ["password"]);
            return {
                ...base,
                kind: "ftp",
                host: normalizeHost(record.ip),
                port: port(record, purpose),
                username: record.username?.trim() || "anonymous",
                password: record.password ?? undefined
            };

        case "s3":
            if (purpose !== "terminal" && purpose !== "files") throw unsupported(record, purpose);
            requireReadable(record, ["s3_secret_key"]);
            return {
                ...base,
                kind: "s3",
                provider: record.s3_provider,
                bucket: record.s3_bucket ?? "",
                region: record.s3_region,
                endpoint: record.s3_endpoint,
                accessKey: record.s3_access_key ?? "",
                secretKey: record.s3_secret_key ?? ""
            };

        case "local": {
            if (purpose !== "terminal") throw unsupported(record, purpose);
            // An unknown preset opens nothing: falling back to the system
            // shell would turn a scoped console into an unrestricted one.
            const savedPreset = record.cli_preset?.trim() || null;
            const cliPreset = savedPreset === null ? null : normalizeCliPreset(savedPreset);
            if (savedPreset !== null && cliPreset === null) {
                throw new ConnectionTargetError(
                    "UNKNOWN_CLI_PRESET",
                    `"${record.name}" is set to the CLI preset "${savedPreset.slice(0, 64)}", which ShellMind does not know. Edit the connection and choose one of: ${CLI_PRESET_KEYS.join(", ")}.`
                );
            }
            return {
                ...base,
                kind: "local",
                command: record.command,
                cwd: record.cwd,
                initialCommand: record.initial_command,
                cliPreset
            };
        }

        default:
            throw new ConnectionTargetError("UNSUPPORTED_PURPOSE", `Server #${record.id} has an unknown type "${record.type}".`);
    }
}
