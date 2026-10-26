// SSH local port forwarding: the API shapes and pure helpers shared by the
// tunnel manager (server/tunnels) and the Tunnels tab (src/features/tunnels).
import type { KnownHost, ServerType, Tunnel } from "./types";

export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_HOST = "127.0.0.1";
export const MAX_TUNNEL_NAME_LENGTH = 80;
export const MAX_REMOTE_HOST_LENGTH = 253;

// Tunnels run over SSH: only these servers have them.
export const TUNNEL_SERVER_TYPES: readonly ServerType[] = ["linux", "windows"];

export function supportsTunnels(type: string): boolean {
    return (TUNNEL_SERVER_TYPES as readonly string[]).includes(type);
}

// Body of POST /api/servers/:id/tunnels and PUT /api/tunnels/:id. PUT only
// changes the fields present in the body.
export type TunnelInput = {
    name?: string | null;
    // Local address to listen on; 127.0.0.1 by default.
    local_host?: string;
    local_port?: number;
    // Address the SSH server connects to; 127.0.0.1 (the server itself) by default.
    remote_host?: string;
    remote_port?: number;
    // Started when the backend starts.
    auto_start?: boolean;
    // Required (true) to listen on an address other machines can reach
    // (0.0.0.0, ::, a LAN address); otherwise 409 PUBLIC_BIND_UNCONFIRMED.
    confirm_public_bind?: boolean;
};

// stopped: not listening. starting: listening while the SSH connection is
// being opened. listening: forwarding. error: the last start failed.
export type TunnelState = "stopped" | "starting" | "listening" | "error";

// Stable codes of tunnel failures (the `code` of API errors and of
// TunnelStatus.lastError). Connection target and host key failures keep their
// own codes (SERVER_NOT_FOUND, SECRET_UNREADABLE, HOST_KEY_MISMATCH...).
export type TunnelErrorCode =
    | "PORT_IN_USE"
    | "PORT_ACCESS_DENIED"
    | "BIND_ADDRESS_UNAVAILABLE"
    | "LISTEN_FAILED"
    | "SSH_CONNECT_FAILED"
    | "SSH_DISCONNECTED"
    // The SSH server could not connect to the remote address.
    | "REMOTE_UNREACHABLE"
    // The SSH server does not allow port forwarding (AllowTcpForwarding, PermitOpen).
    | "FORWARDING_DENIED"
    // A stop, or a restart with other endpoints, came while it was starting.
    | "TUNNEL_START_CANCELLED"
    // Invalid input; details.field names the field.
    | "INVALID_TUNNEL";

// What a failure is about: the local address it could not listen on and, when
// another tunnel holds it, that tunnel.
export type TunnelErrorDetails = {
    field?: string;
    host?: string;
    port?: number;
    tunnelId?: number;
    tunnelName?: string;
};

export type TunnelErrorInfo = {
    code: string;
    message: string;
    // Epoch ms.
    at: number;
    details?: TunnelErrorDetails;
};

export type TunnelStatus = {
    state: TunnelState;
    // Local client connections open now / accepted since the tunnel started.
    activeConnections: number;
    totalConnections: number;
    // Bytes sent from local clients to the remote service / received from it.
    bytesOut: number;
    bytesIn: number;
    // Epoch ms of the current start, null while stopped.
    startedAt: number | null;
    // Kept until the next start: a failed start, or a forwarded connection
    // that could not be opened.
    lastError: TunnelErrorInfo | null;
};

// A saved tunnel with its live status (GET /api/servers/:id/tunnels).
export type TunnelView = Tunnel & { status: TunnelStatus };

// GET /api/servers/:id/host-key: the SSH endpoint of a saved server and the
// host key pinned for it, if any.
export type ServerHostKey = {
    host: string;
    port: number;
    knownHost: KnownHost | null;
};

export type TunnelPresetId = "postgresql" | "mysql" | "redis" | "mongodb" | "http" | "https" | "kubernetes" | "rdp" | "custom";

export type TunnelPreset = {
    id: TunnelPresetId;
    // Product name (not translated); the UI labels the custom preset.
    name: string;
    remotePort: number | null;
};

export const TUNNEL_PRESETS: readonly TunnelPreset[] = [
    { id: "postgresql", name: "PostgreSQL", remotePort: 5432 },
    { id: "mysql", name: "MySQL / MariaDB", remotePort: 3306 },
    { id: "redis", name: "Redis", remotePort: 6379 },
    { id: "mongodb", name: "MongoDB", remotePort: 27017 },
    { id: "http", name: "HTTP", remotePort: 80 },
    { id: "https", name: "HTTPS", remotePort: 443 },
    { id: "kubernetes", name: "Kubernetes API", remotePort: 6443 },
    { id: "rdp", name: "RDP", remotePort: 3389 },
    { id: "custom", name: "", remotePort: null }
];

export function presetForPort(remotePort: number): TunnelPreset | undefined {
    return TUNNEL_PRESETS.find((preset) => preset.remotePort === remotePort);
}

// Local port suggested for a remote one: shifted by 10000 so it does not clash
// with a local instance of the same service (PostgreSQL 5432 -> 15432).
export function suggestedLocalPort(remotePort: number): number {
    return remotePort + 10_000 <= 65_535 ? remotePort + 10_000 : remotePort;
}

export function isValidPort(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

const unbracket = (host: string) => host.trim().replace(/^\[(.*)\]$/, "$1");
const stripBrackets = (host: string) => unbracket(host).toLowerCase();

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/;

function isIPv6(value: string): boolean {
    // Without the zone of a link-local address ("fe80::1%eth0").
    let address = value.replace(/%[0-9A-Za-z._-]+$/, "");
    const lastColon = address.lastIndexOf(":");
    if (lastColon === -1) return false;
    // An IPv4 tail ("::ffff:10.0.0.1") stands for two groups.
    const tail = address.slice(lastColon + 1);
    if (tail.includes(".")) {
        if (!IPV4.test(tail)) return false;
        address = `${address.slice(0, lastColon + 1)}0:0`;
    }
    const halves = address.split("::");
    if (halves.length > 2) return false;
    const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
    if (!groups.every((group) => IPV6_GROUP.test(group))) return false;
    return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

// An IPv4 or IPv6 address literal (optionally in brackets), as net.isIP() takes it.
export function isIpLiteral(value: string): boolean {
    const host = unbracket(value);
    return IPV4.test(host) || isIPv6(host);
}

// Where a tunnel may listen: an IP address of this machine, or "localhost"
// (saved as 127.0.0.1).
export function isValidBindHost(value: string): boolean {
    return stripBrackets(value) === "localhost" || isIpLiteral(value);
}

// A host name or an IP address, resolved by the SSH server.
export function isValidRemoteHost(value: string): boolean {
    const host = unbracket(value);
    return host.length > 0 && host.length <= MAX_REMOTE_HOST_LENGTH && /^[A-Za-z0-9._:%-]+$/.test(host);
}

// Loopback addresses only accept connections from this machine.
export function isLoopbackHost(host: string): boolean {
    const bare = stripBrackets(host);
    return bare === "localhost"
        || bare === "::1"
        || /^127(\.\d{1,3}){3}$/.test(bare)
        || /^::ffff:127(\.\d{1,3}){3}$/.test(bare);
}

// Listening on these means every interface of the machine.
export function isWildcardHost(host: string): boolean {
    const bare = stripBrackets(host);
    return bare === "0.0.0.0" || bare === "::";
}

// "127.0.0.1:5432", or "[::1]:5432" for IPv6 addresses.
export function formatHostPort(host: string, port: number): string {
    const bare = unbracket(host);
    return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

// Where local programs connect to reach the tunnel (a wildcard listener is
// reachable on loopback).
export function tunnelConnectAddress(tunnel: Pick<Tunnel, "local_host" | "local_port">): string {
    const bare = stripBrackets(tunnel.local_host);
    const host = bare === "::" ? "::1" : bare === "0.0.0.0" ? "127.0.0.1" : tunnel.local_host;
    return formatHostPort(host, tunnel.local_port);
}

const HTTP_PORTS = new Set([80, 3000, 5000, 8000, 8008, 8080, 8081, 8888, 9000, 9090]);
const HTTPS_PORTS = new Set([443, 8443, 9443]);

// The URL to open in a browser when the remote service is a web server on a
// well-known port, otherwise null.
export function tunnelUrl(tunnel: Pick<Tunnel, "local_host" | "local_port" | "remote_port">): string | null {
    const scheme = HTTPS_PORTS.has(tunnel.remote_port) ? "https" : HTTP_PORTS.has(tunnel.remote_port) ? "http" : null;
    return scheme ? `${scheme}://${tunnelConnectAddress(tunnel)}/` : null;
}

// `ssh -L` notation of a tunnel, e.g. "127.0.0.1:15432 -> 127.0.0.1:5432".
export function describeTunnel(tunnel: Pick<Tunnel, "local_host" | "local_port" | "remote_host" | "remote_port">): string {
    return `${formatHostPort(tunnel.local_host, tunnel.local_port)} -> ${formatHostPort(tunnel.remote_host, tunnel.remote_port)}`;
}
