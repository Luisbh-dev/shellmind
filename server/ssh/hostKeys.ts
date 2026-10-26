import { createHash } from "crypto";

// SSH host keys arrive in wire format: string(key type) followed by the key data.

// OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of the SHA-256 of the key blob.
export function sshFingerprint(key: Buffer): string {
    return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function sshKeyType(key: Buffer): string {
    if (key.length < 4) return "unknown";
    const length = key.readUInt32BE(0);
    if (length === 0 || length > 64 || key.length < 4 + length) return "unknown";
    return key.subarray(4, 4 + length).toString("ascii");
}

type Route = { host: string; port: number; jump: Route | null };

// The jump hosts a host is reached through, as host:port from the first one
// connected to the last, joined with ">"; "" for a direct connection. Part of
// the identity of a pinned host key: 10.0.0.5:22 behind one bastion and
// 10.0.0.5:22 behind another are different machines.
export function routeVia(target: Route): string {
    const hops: string[] = [];
    for (let hop = target.jump; hop; hop = hop.jump) hops.unshift(`${hop.host}:${hop.port}`);
    return hops.join(">");
}

export class HostKeyMismatchError extends Error {
    readonly code = "HOST_KEY_MISMATCH";

    constructor(
        readonly host: string,
        readonly port: number,
        readonly keyType: string,
        readonly expected: string,
        readonly actual: string,
        readonly via = ""
    ) {
        super(
            `The host key of ${host}:${port}${via ? ` (via ${via})` : ""} has changed (expected ${expected}, got ${actual}). ` +
            "This can mean the server was reinstalled, or that someone is intercepting the connection. " +
            "If the change is expected, remove the old key from Known hosts and connect again."
        );
        this.name = "HostKeyMismatchError";
    }
}
