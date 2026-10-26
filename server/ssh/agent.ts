import { execFile } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { Duplex } from "stream";
import {
    createAgent, OpenSSHAgent, type BaseAgent, type Client, type ClientChannel, type GetStreamCallback, type ParsedKey, type PseudoTtyOptions, type ShellOptions
} from "ssh2";
import type { AgentErrorCode, AgentKey, AgentSource, AgentStatus, AgentUnavailableReason } from "../../shared/identities";
import { isLoopbackHost } from "../../shared/tunnels";
import { HOST, SSH_AGENT, SSH_AUTH_SOCK } from "../config";
import { errorMessage } from "../errors";
import { localProcessEnv } from "../local/env";
import { createLogger } from "../logger";
import { sshFingerprint } from "./hostKeys";

const log = createLogger("ssh");

// W7-S2: the SSH agent identities sign in with (ssh2's `agent` option), and
// agent forwarding on interactive terminal shells.
//
// Where the agent is: SHELLMIND_SSH_AGENT (a socket or pipe path, "pageant",
// or "off"), else SSH_AUTH_SOCK, else on Windows the OpenSSH agent pipe when
// it exists, else Pageant. The agent belongs to the machine the backend runs
// on: when the backend listens beyond loopback (self-hosted web mode) it is
// someone else's agent from the browser user's point of view, so it is only
// used when SHELLMIND_SSH_AGENT names it explicitly.
//
// Forwarding lets the remote host (anyone with root there) use the agent's
// keys while the connection is open. It is off unless a server turns it on,
// and only interactive terminal shells request it (requestShellChannel), never
// the status, operations or multi-exec commands. sshd keeps it for the whole
// connection once requested, which the pool shares with those channels, so it
// lasts until the pooled connection closes.

export const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";
export const PAGEANT = "pageant";

export type AgentLocation =
    | { path: string; source: AgentSource }
    | { path: null; reason: AgentUnavailableReason };

export type AgentEnvironment = {
    override: string;
    authSock: string;
    host: string;
    platform: NodeJS.Platform;
    pipeExists: (pipe: string) => boolean;
};

const DISABLED = /^(off|none|no|false|0|disabled)$/i;

const currentEnvironment = (): AgentEnvironment => ({
    override: SSH_AGENT,
    authSock: SSH_AUTH_SOCK,
    host: HOST,
    platform: process.platform,
    pipeExists: (pipe) => fs.existsSync(pipe)
});

// Looked up on every connection: an agent started later (the Windows service,
// Pageant) is picked up without restarting ShellMind.
export function locateAgent(env: AgentEnvironment = currentEnvironment()): AgentLocation {
    if (env.override) {
        if (DISABLED.test(env.override)) return { path: null, reason: "disabled" };
        if (env.override.toLowerCase() === PAGEANT) return env.platform === "win32" ? { path: PAGEANT, source: "env" } : { path: null, reason: "not-found" };
        return { path: env.override, source: "env" };
    }
    if (!isLoopbackHost(env.host)) return { path: null, reason: "remote-backend" };
    if (env.authSock) return { path: env.authSock, source: "ssh-auth-sock" };
    if (env.platform === "win32") {
        return env.pipeExists(WINDOWS_AGENT_PIPE) ? { path: WINDOWS_AGENT_PIPE, source: "windows-openssh" } : { path: PAGEANT, source: "pageant" };
    }
    return { path: null, reason: "not-found" };
}

// --- Pageant ------------------------------------------------------------------

// ssh2's PageantAgent runs its helper pagent.exe with spawn() from inside
// node_modules, which fails in the packaged app: the file is inside app.asar
// and only execFile() can run a program from there. The same protocol: one
// agent request per helper run, the request on stdin, the answer on stdout.
const PAGEANT_ERRORS: Record<number, string> = {
    10: "Invalid pagent.exe arguments",
    11: "Pageant is not running",
    12: "pagent.exe could not create an mmap",
    13: "pagent.exe could not set mode for stdin",
    14: "pagent.exe could not set mode for stdout",
    15: "pagent.exe did not get expected input payload"
};

let pagentPath: string | null = null;

function pagentExe(): string {
    pagentPath ??= path.join(path.dirname(createRequire(__filename).resolve("ssh2/package.json")), "util", "pagent.exe");
    return pagentPath;
}

class PageantSocket extends Duplex {
    private buffer: Buffer | null = null;
    private child: ReturnType<typeof execFile> | null = null;

    _read(): void {
        // Answers are pushed when the helper ends.
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void): void {
        this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
        if (this.buffer.length < 4) return done();
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length - 4 < length) return done();
        if (this.buffer.length > length + 4) return done(new Error("Unexpected multiple agent requests"));
        const request = this.buffer;
        this.buffer = null;
        const child = execFile(pagentExe(), [String(request.length)], { encoding: "buffer", env: localProcessEnv(), windowsHide: true, timeout: 30_000 }, (err, stdout) => {
            this.child = null;
            // A non-zero exit status is the helper's error code.
            const code = err?.code;
            if (err) return done(new Error(typeof code === "number" ? PAGEANT_ERRORS[code] ?? `pagent.exe failed (${code})` : errorMessage(err)));
            this.push(stdout);
            done();
        });
        this.child = child;
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(request);
    }

    _final(done: (err?: Error | null) => void): void {
        this.stop();
        done();
    }

    _destroy(err: Error | null, done: (err?: Error | null) => void): void {
        this.stop();
        done(err);
    }

    private stop(): void {
        this.buffer = null;
        this.child?.kill();
        this.child = null;
    }
}

export class PageantAgent extends OpenSSHAgent {
    constructor() {
        super(PAGEANT);
    }

    getStream(cb: GetStreamCallback): void {
        cb(null, new PageantSocket());
    }
}

// The ssh2 agent for a located path (a socket / pipe path or "pageant").
export function createAgentFor(location: string): BaseAgent {
    return location === PAGEANT ? new PageantAgent() : createAgent(location);
}

// --- Status -------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 5000;

const PROBE_TIMEOUT_MESSAGE = `The SSH agent did not answer within ${PROBE_TIMEOUT_MS / 1000}s`;

// Why the agent did not answer, for the client to word (the English message
// stays in `error`). ssh2 says "Failed to connect to agent" for a socket or
// pipe nothing listens on.
function agentErrorCode(message: string): AgentErrorCode | undefined {
    if (message === PAGEANT_ERRORS[11]) return "not-running";
    if (message === PROBE_TIMEOUT_MESSAGE) return "timeout";
    if (message === "Failed to connect to agent") return "unreachable";
    return undefined;
}

function describeKey(key: ParsedKey): AgentKey {
    return { type: key.type, fingerprint: sshFingerprint(key.getPublicSSH()), comment: key.comment ?? "" };
}

function listKeys(agent: BaseAgent): Promise<ParsedKey[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(PROBE_TIMEOUT_MESSAGE)), PROBE_TIMEOUT_MS);
        try {
            agent.getIdentities((err, keys) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve((keys ?? []).filter((key): key is ParsedKey => typeof key === "object" && key !== null && "getPublicSSH" in key));
            });
        } catch (err) {
            clearTimeout(timer);
            reject(err as Error);
        }
    });
}

// Whether the agent answers, and the keys it offers (GET /api/identities/agent).
export async function agentStatus(env?: AgentEnvironment): Promise<AgentStatus> {
    const location = locateAgent(env);
    if (location.path === null) return { available: false, source: null, reason: location.reason };
    try {
        const keys = await listKeys(createAgentFor(location.path));
        return { available: true, source: location.source, keys: keys.map(describeKey) };
    } catch (err) {
        const error = errorMessage(err) || "The SSH agent could not be reached";
        const errorCode = agentErrorCode(error);
        return { available: false, source: location.source, error, ...(errorCode ? { errorCode } : {}) };
    }
}

// --- Forwarding ---------------------------------------------------------------

type ShellCallback = (err: Error | undefined, stream: ClientChannel | undefined) => void;

// Opens an interactive shell channel, requesting agent forwarding when the
// target has it on (the connection was then set up with the agent). ssh2
// fails the whole channel when the server refuses forwarding (sshd
// AllowAgentForwarding no): the shell is then opened again without it, like
// OpenSSH's client, which only warns. Throws like client.shell() when the
// connection is gone.
export function requestShellChannel(client: Client, window: PseudoTtyOptions, target: { serverId: number; agentForward?: boolean }, callback: ShellCallback): void {
    if (!target.agentForward) {
        client.shell(window, callback);
        return;
    }
    client.shell(window, { agentForward: true } as ShellOptions, (err, stream) => {
        if (!err || !/agent forwarding/i.test(err.message)) {
            callback(err, stream);
            return;
        }
        log.warn(`Server #${target.serverId} refused SSH agent forwarding; the terminal opens without it`);
        try {
            client.shell(window, callback);
        } catch (retryErr) {
            callback(retryErr as Error, undefined);
        }
    });
}
