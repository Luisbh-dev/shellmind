import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildRdpFileContent, type RdpClientKind, type RdpSupport } from "../../shared/rdp";
import type { RdpTarget } from "../connections/target";
import { AppError } from "../errors";
import { createLogger } from "../logger";
import { localProcessEnv } from "./env";
import { runCommand } from "./process";
import { resolveExecutable } from "./resolve";

// Opens the operating system's Remote Desktop client for a saved Windows
// server. Programs are started directly (never through a shell) and the
// password never appears in a log line, an error message or a file:
//   Windows  cmdkey stores it for mstsc, which reads it, then it is deleted
//   macOS    a .rdp file opened with the default client (it asks for it)
//   Linux    xfreerdp reads it from stdin; Remmina asks; else a .rdp file

const log = createLogger("rdp");

// mstsc reads the stored credential when it connects; it is removed when
// mstsc exits, or after this long at the latest.
const CREDENTIAL_TTL_MS = 30_000;
const RDP_FILE_TTL_MS = 60_000;

export type RdpLaunchDeps = {
    platform: NodeJS.Platform;
    resolve: (name: string) => Promise<string | null>;
    // Runs a short program to completion; resolves with its exit code (null if
    // it could not start) and what it printed.
    run: (file: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;
    // Starts a program that keeps running on its own (the RDP client); resolves
    // once it started and calls onExit when it ends.
    start: (file: string, args: string[], options: { input?: string; onExit?: () => void }) => Promise<void>;
    writeRdpFile: (name: string, content: string) => Promise<string>;
};

function startDetached(file: string, args: string[], options: { input?: string; onExit?: () => void }): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            env: localProcessEnv(),
            detached: true,
            stdio: [options.input === undefined ? "ignore" : "pipe", "ignore", "ignore"]
        });
        child.once("error", reject);
        child.once("spawn", () => {
            child.off("error", reject);
            child.on("error", (err) => log.warn(`${path.basename(file)} failed: ${err.message}`));
            if (options.input !== undefined) {
                child.stdin?.on("error", () => { /* the client stopped reading */ });
                child.stdin?.end(options.input);
            }
            child.once("exit", () => options.onExit?.());
            child.unref();
            resolve();
        });
    });
}

async function writeRdpFile(name: string, content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shellmind-rdp-"));
    const file = path.join(dir, `${name}.rdp`);
    await fs.writeFile(file, content, { mode: 0o600 });
    setTimeout(() => {
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }, RDP_FILE_TTL_MS).unref();
    return file;
}

export const systemRdpDeps: RdpLaunchDeps = {
    platform: process.platform,
    resolve: (name) => resolveExecutable(name, { env: localProcessEnv() }),
    run: async (file, args) => {
        const { code, stdout } = await runCommand(file, args, { env: localProcessEnv(), timeoutMs: 15_000 });
        return { code, stdout };
    },
    start: startDetached,
    writeRdpFile
};

// Host names as Windows networks use them: DNS labels plus underscores
// (NetBIOS and AD names such as win_srv01.corp.local). A leading "-" or "/"
// is never accepted, so a host cannot turn into a client option.
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*\.?$/;
// IPv6, with the zone of a link-local address (fe80::1%eth0, fe80::1%12).
const IPV6 = /^[0-9A-Fa-f:.]{2,45}(?:%[A-Za-z0-9_.-]{1,32})?$/;

// Logon names and domains: no control characters (line breaks included) or quotes.
function isAccountText(text: string): boolean {
    return [...text].every((ch) => ch !== "\"" && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f);
}

function invalidTarget(message: string): AppError {
    return new AppError("RDP_INVALID_TARGET", message, 400);
}

// Also checked by the embedded client gateway (server/rdp) before it connects.
export function checkRdpTarget(target: RdpTarget): void {
    if (!(HOSTNAME.test(target.host) || (target.host.includes(":") && IPV6.test(target.host)))) {
        throw invalidTarget(`"${target.host}" is not a valid host name or IP address.`);
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw invalidTarget(`${target.port} is not a valid port.`);
    if (!isAccountText(target.username) || !isAccountText(target.domain ?? "")) {
        throw invalidTarget("The user name or domain contains characters Remote Desktop cannot use.");
    }
}

function hostWithPort(target: RdpTarget): string {
    const host = target.host.includes(":") ? `[${target.host}]` : target.host;
    return `${host}:${target.port}`;
}

function logonName(target: RdpTarget): string {
    return target.domain ? `${target.domain}\\${target.username}` : target.username;
}

// A .rdp file that asks for the password (it is never written to disk).
export function buildRdpFile(target: RdpTarget): string {
    return buildRdpFileContent({ host: target.host, port: target.port, username: target.username, domain: target.domain });
}

function fileNameFor(target: RdpTarget): string {
    return target.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "remote-desktop";
}

// Which client this machine would use, if any.
export async function detectRdpSupport(deps: RdpLaunchDeps = systemRdpDeps): Promise<RdpSupport> {
    const found = async (name: string) => (await deps.resolve(name)) !== null;
    let client: RdpClientKind | null = null;
    if (deps.platform === "win32") {
        if (await found("mstsc")) client = "mstsc";
    } else if (deps.platform === "darwin") {
        if (await found("open")) client = "rdp-file";
    } else {
        for (const candidate of ["xfreerdp3", "xfreerdp", "remmina"] as const) {
            if (await found(candidate)) { client = candidate; break; }
        }
        if (!client && await found("xdg-open")) client = "rdp-file";
    }
    return { supported: client !== null, client, platform: deps.platform };
}

function unsupported(platform: NodeJS.Platform): AppError {
    return new AppError(
        "RDP_UNSUPPORTED",
        `No Remote Desktop client was found on this computer (${platform}). Install one (mstsc on Windows, FreeRDP or Remmina on Linux) or download the .rdp file instead.`,
        501
    );
}

// Credentials this backend stored for mstsc and has not deleted yet, with the
// number of launches still using each.
const ownCredentials = new Map<string, number>();

// Whether Windows may already hold a credential for `credential` that the
// user saved (mstsc's "Remember me"). cmdkey exits with 0 either way and its
// text is localized, but its header names the target once and every stored
// entry names it again. Unknown counts as yes: the user's credential must
// never be overwritten or deleted.
async function mayHaveCredential(cmdkey: string, credential: string, deps: RdpLaunchDeps): Promise<boolean> {
    const { code, stdout } = await deps.run(cmdkey, [`/list:${credential}`]);
    if (code !== 0) return true;
    return stdout.toLowerCase().split(credential.toLowerCase()).length - 1 >= 2;
}

async function launchWindows(target: RdpTarget, deps: RdpLaunchDeps): Promise<void> {
    const mstsc = await deps.resolve("mstsc");
    if (!mstsc) throw unsupported(deps.platform);
    const credential = `TERMSRV/${target.host}`;

    let stored = false;
    if (target.password) {
        const cmdkey = await deps.resolve("cmdkey");
        if (!cmdkey) throw new AppError("RDP_CREDENTIALS", "cmdkey was not found, so the saved password cannot be handed to Remote Desktop.", 500);
        if (ownCredentials.has(credential) || !(await mayHaveCredential(cmdkey, credential, deps))) {
            // The exit code only: the command line holds the password.
            const { code } = await deps.run(cmdkey, [`/generic:${credential}`, `/user:${logonName(target)}`, `/pass:${target.password}`]);
            if (code !== 0) {
                throw new AppError("RDP_CREDENTIALS", `Could not store the Remote Desktop credentials (cmdkey ${code === null ? "did not run" : `exited with code ${code}`}).`, 500);
            }
            stored = true;
            ownCredentials.set(credential, (ownCredentials.get(credential) ?? 0) + 1);
        } else {
            log.info(`Server #${target.serverId}: Windows already holds Remote Desktop credentials for this host; mstsc uses those`);
        }
    }

    let removed = false;
    const removeCredential = () => {
        if (!stored || removed) return;
        removed = true;
        const users = (ownCredentials.get(credential) ?? 1) - 1;
        if (users > 0) {
            ownCredentials.set(credential, users);
            return;
        }
        ownCredentials.delete(credential);
        void deps.resolve("cmdkey").then((cmdkey) => (cmdkey ? deps.run(cmdkey, [`/delete:${credential}`]) : null));
    };
    try {
        await deps.start(mstsc, [`/v:${hostWithPort(target)}`], { onExit: removeCredential });
    } catch {
        removeCredential();
        throw new AppError("RDP_LAUNCH_FAILED", "Could not start the Remote Desktop client (mstsc).", 500);
    }
    if (stored) setTimeout(removeCredential, CREDENTIAL_TTL_MS).unref();
}

async function openRdpFile(target: RdpTarget, opener: string, deps: RdpLaunchDeps): Promise<void> {
    const file = await deps.writeRdpFile(fileNameFor(target), buildRdpFile(target));
    try {
        await deps.start(opener, [file], {});
    } catch {
        throw new AppError("RDP_LAUNCH_FAILED", `Could not open the .rdp file with ${path.basename(opener)}.`, 500);
    }
}

async function launchLinux(target: RdpTarget, client: RdpClientKind, deps: RdpLaunchDeps): Promise<void> {
    const file = await deps.resolve(client === "rdp-file" ? "xdg-open" : client);
    if (!file) throw unsupported(deps.platform);
    if (client === "rdp-file") return openRdpFile(target, file, deps);

    let args: string[];
    let input: string | undefined;
    if (client === "remmina") {
        const user = target.username ? `${encodeURIComponent(logonName(target))}@` : "";
        // In a URI the "%" of an IPv6 zone is written "%25".
        args = ["-c", `rdp://${user}${hostWithPort(target).replace("%", "%25")}`];
    } else {
        args = [`/v:${hostWithPort(target)}`, "/cert:tofu", "/dynamic-resolution"];
        if (target.username) args.push(`/u:${target.username}`);
        if (target.domain) args.push(`/d:${target.domain}`);
        if (target.password) {
            // Read from stdin, so it is not on the command line.
            args.push("/from-stdin:force");
            input = `${target.password}\n`;
        }
    }
    try {
        await deps.start(file, args, { input });
    } catch {
        throw new AppError("RDP_LAUNCH_FAILED", `Could not start the Remote Desktop client (${client}).`, 500);
    }
}

// Starts the native client for `target` and says which one was used.
export async function launchNativeRdp(target: RdpTarget, deps: RdpLaunchDeps = systemRdpDeps): Promise<{ client: RdpClientKind }> {
    checkRdpTarget(target);
    const support = await detectRdpSupport(deps);
    if (!support.client) throw unsupported(deps.platform);

    log.info(`Opening ${support.client} for server #${target.serverId}`);
    if (deps.platform === "win32") await launchWindows(target, deps);
    else if (deps.platform === "darwin") {
        const open = await deps.resolve("open");
        if (!open) throw unsupported(deps.platform);
        await openRdpFile(target, open, deps);
    } else await launchLinux(target, support.client, deps);
    return { client: support.client };
}
