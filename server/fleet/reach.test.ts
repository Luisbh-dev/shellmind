import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import { ExecAbortedError } from "../ssh/exec";
import { reachServer, reachSsh } from "./reach";

// The reachability check against real TCP listeners on loopback.

const listeners: net.Server[] = [];

async function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer(onConnection);
    listeners.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

const never = () => new AbortController().signal;

afterEach(async () => {
    for (const server of listeners.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("reachability check", () => {
    it("reads the SSH greeting and sends nothing", async () => {
        const sent: Buffer[] = [];
        const port = await listen((socket) => {
            socket.on("data", (chunk) => sent.push(chunk));
            socket.on("error", () => undefined);
            socket.write("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n");
        });
        const result = await reachSsh({ host: "127.0.0.1", port }, never());
        expect(result.greeting).toBe("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13");
        expect(result.ms).toBeGreaterThanOrEqual(0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(Buffer.concat(sent).length).toBe(0);
    });

    it("accepts lines before the identification, in pieces", async () => {
        const port = await listen((socket) => {
            socket.on("error", () => undefined);
            socket.write("Welcome\r\nSSH-2.0-dropbear");
            setTimeout(() => socket.write("_2022.83\r\n"), 20);
        });
        expect((await reachSsh({ host: "127.0.0.1", port }, never())).greeting).toBe("SSH-2.0-dropbear_2022.83");
    });

    it("reports a closed port", async () => {
        await expect(reachSsh({ host: "127.0.0.1", port: await closedPort() }, never())).rejects.toMatchObject({ code: "ECONNREFUSED" });
    });

    it("reports a server that never greets, or hangs up first, or is something else", async () => {
        const silent = await listen((socket) => socket.on("error", () => undefined));
        await expect(reachSsh({ host: "127.0.0.1", port: silent }, never(), 200)).rejects.toMatchObject({ code: "HANDSHAKE_TIMEOUT" });

        const rude = await listen((socket) => socket.end());
        await expect(reachSsh({ host: "127.0.0.1", port: rude }, never())).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });

        const web = await listen((socket) => {
            socket.on("error", () => undefined);
            socket.write(`HTTP/1.1 400 Bad Request\r\n${"X-Pad: x\r\n".repeat(1000)}`);
        });
        await expect(reachSsh({ host: "127.0.0.1", port: web }, never())).rejects.toMatchObject({ code: "NOT_SSH" });
    });

    it("stops when asked to", async () => {
        const silent = await listen((socket) => socket.on("error", () => undefined));
        const controller = new AbortController();
        const pending = reachSsh({ host: "127.0.0.1", port: silent }, controller.signal);
        setTimeout(() => controller.abort(), 20);
        await expect(pending).rejects.toBeInstanceOf(ExecAbortedError);
    });
});

// W7 integration: a Windows server reached over Remote Desktop only.
describe("reachability of a Windows server", () => {
    it("counts its Remote Desktop port when its SSH port does not answer, without sending anything", async () => {
        const sent: Buffer[] = [];
        const rdpPort = await listen((socket) => {
            socket.on("data", (chunk) => sent.push(chunk));
            socket.on("error", () => undefined);
        });
        const result = await reachServer({ host: "127.0.0.1", port: await closedPort(), rdpPort }, never());
        expect(result).toMatchObject({ greeting: "", service: "rdp" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(Buffer.concat(sent).length).toBe(0);
    });

    it("prefers its SSH server, and reports the SSH failure when neither answers", async () => {
        const ssh = await listen((socket) => {
            socket.on("error", () => undefined);
            socket.write("SSH-2.0-OpenSSH_for_Windows_9.5\r\n");
        });
        expect(await reachServer({ host: "127.0.0.1", port: ssh, rdpPort: await closedPort() }, never())).toMatchObject({ greeting: "SSH-2.0-OpenSSH_for_Windows_9.5" });
        await expect(reachServer({ host: "127.0.0.1", port: await closedPort(), rdpPort: await closedPort() }, never())).rejects.toMatchObject({ code: "ECONNREFUSED" });
        // Without an RDP port (Linux), only SSH counts.
        await expect(reachServer({ host: "127.0.0.1", port: await closedPort() }, never())).rejects.toMatchObject({ code: "ECONNREFUSED" });
    });
});
