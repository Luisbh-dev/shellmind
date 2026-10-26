// Port defaults of saved servers, shared by the backend (which resolves the
// port at connect time) and the frontend (placeholders and labels).
import type { ConnectionPurpose, ServerType } from "./types";

// The default port of a server type for one purpose, or null when that purpose
// does not use a network port of that server (S3, local consoles, RDP to Linux).
export function defaultPort(type: ServerType, purpose: ConnectionPurpose): number | null {
    switch (type) {
        case "linux":
            return purpose === "rdp" ? null : 22;
        case "windows":
            return purpose === "rdp" ? 3389 : 22;
        case "ftp":
            return purpose === "terminal" || purpose === "files" ? 21 : null;
        default:
            return null;
    }
}

// The port a saved server is reached on for one purpose. Windows servers keep
// the RDP port in `port` and the SSH port in `ssh_port`; every other type uses
// `port`. A blank (null/0) column falls back to the default.
export function effectivePort(
    server: { type: ServerType; port?: number | null; ssh_port?: number | null },
    purpose: ConnectionPurpose
): number | null {
    const fallback = defaultPort(server.type, purpose);
    if (fallback === null) return null;
    const stored = server.type === "windows" && purpose !== "rdp" ? server.ssh_port : server.port;
    return stored && stored > 0 ? stored : fallback;
}
