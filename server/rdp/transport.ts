import net from "net";
import type { Duplex } from "stream";
import type { ClientChannel } from "ssh2";
import { formatRdpAddress } from "../../shared/rdp";
import { describeSshError, type SshLease } from "../ssh/pool";
import { RdpGatewayFailure, socketFailure } from "./failure";
import { GENERAL_ERROR_CODE } from "./rdcleanpath";
import type { RdpRoute } from "./route";

// The TCP connection to the RDP server: direct, or a direct-tcpip channel of
// the jump host's pooled SSH connection (the jump host connects to it).

export type RdpTransport = {
    stream: Duplex;
    // The address the server was reached at (an IP when direct).
    serverAddr: string;
    close: () => void;
};

export type TransportDeps = {
    acquire: (serverId: number) => Promise<SshLease>;
};

function connectDirect(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<RdpTransport> {
    const address = formatRdpAddress(host, port);
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const fail = (err: unknown) => {
            cleanup();
            socket.destroy();
            reject(err instanceof RdpGatewayFailure ? err : socketFailure(err, address));
        };
        const onAbort = () => fail(new RdpGatewayFailure("RDP_INTERNAL", "The connection was cancelled."));
        const timer = setTimeout(() => fail(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            socket.off("error", fail);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        socket.once("error", fail);
        socket.once("connect", () => {
            cleanup();
            // Errors after this point end the relay through "close".
            socket.on("error", () => undefined);
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 30_000);
            resolve({
                stream: socket,
                serverAddr: socket.remoteAddress ? formatRdpAddress(socket.remoteAddress, socket.remotePort ?? port) : address,
                close: () => socket.destroy()
            });
        });
    });
}

async function connectThroughJump(route: RdpRoute, deps: TransportDeps, timeoutMs: number, signal: AbortSignal): Promise<RdpTransport> {
    const jump = route.jump!;
    const { host, port } = route.target;
    const address = formatRdpAddress(host, port);
    const jumpFailure = (reason: string) => new RdpGatewayFailure(
        "RDP_JUMP_FAILED",
        `The jump host ${jump.name} could not reach ${address}: ${reason}`,
        { errorCode: GENERAL_ERROR_CODE, wsaLastError: 10060 },
        { details: { jump: jump.name, address, reason } }
    );

    let lease: SshLease;
    try {
        lease = await deps.acquire(jump.serverId);
    } catch (err) {
        throw new RdpGatewayFailure(
            "RDP_JUMP_FAILED",
            `Could not connect to the jump host ${jump.name}: ${describeSshError(err)}`,
            { errorCode: GENERAL_ERROR_CODE, wsaLastError: 10060 },
            { details: { jump: jump.name, address, reason: describeSshError(err) } }
        );
    }
    if (signal.aborted) {
        lease.release();
        throw new RdpGatewayFailure("RDP_INTERNAL", "The connection was cancelled.");
    }

    const channel = await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false;
        const settle = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            outcome();
        };
        const onAbort = () => settle(() => reject(new RdpGatewayFailure("RDP_INTERNAL", "The connection was cancelled.")));
        const timer = setTimeout(() => settle(() => reject(jumpFailure("the connection timed out"))), timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            lease.client.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
                if (err) settle(() => reject(jumpFailure(err.message)));
                else if (settled) stream.close();
                else settle(() => resolve(stream));
            });
        } catch (err) {
            settle(() => reject(jumpFailure(err instanceof Error ? err.message : String(err))));
        }
    }).catch((err: unknown) => {
        lease.release();
        throw err;
    });

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        lease.release();
    };
    channel.on("error", () => undefined);
    channel.once("close", release);
    return {
        stream: channel,
        serverAddr: address,
        close: () => {
            try { channel.close(); } catch { /* already closed */ }
            release();
        }
    };
}

export function openRdpTransport(route: RdpRoute, deps: TransportDeps, timeoutMs: number, signal: AbortSignal): Promise<RdpTransport> {
    return route.jump
        ? connectThroughJump(route, deps, timeoutMs, signal)
        : connectDirect(route.target.host, route.target.port, timeoutMs, signal);
}
