import {
    DEFAULT_BIND_HOST,
    DEFAULT_REMOTE_HOST,
    formatHostPort,
    isLoopbackHost,
    isValidBindHost,
    isValidPort,
    isValidRemoteHost,
    MAX_TUNNEL_NAME_LENGTH,
    type TunnelInput
} from "../../shared/tunnels";
import type { Tunnel } from "../../shared/types";
import { AppError } from "../errors";
import type { TunnelFields } from "./repo";

type Field = keyof TunnelInput;

// details.field lets the UI say which field is wrong in the user's language.
function invalid(field: Field, message: string): AppError {
    return new AppError("INVALID_TUNNEL", message, 400, { field });
}

const unbracket = (host: string) => host.trim().replace(/^\[(.*)\]$/, "$1");

// The address to listen on: an IP literal of this machine. "localhost" is
// stored as 127.0.0.1, since Node may resolve it to ::1 while clients try
// 127.0.0.1 first. The UI validates with the same shared check.
export function parseBindHost(value: unknown): string {
    if (value === undefined || value === null || value === "") return DEFAULT_BIND_HOST;
    if (typeof value !== "string") throw invalid("local_host", "local_host must be a string");
    if (!isValidBindHost(value)) throw invalid("local_host", "local_host must be an IP address of this machine, such as 127.0.0.1");
    const host = unbracket(value);
    return host.toLowerCase() === "localhost" ? DEFAULT_BIND_HOST : host;
}

export function parseRemoteHost(value: unknown): string {
    if (value === undefined || value === null || value === "") return DEFAULT_REMOTE_HOST;
    if (typeof value !== "string") throw invalid("remote_host", "remote_host must be a string");
    if (!isValidRemoteHost(value)) throw invalid("remote_host", "remote_host must be a host name or an IP address");
    return unbracket(value);
}

function parsePort(value: unknown, field: "local_port" | "remote_port"): number {
    const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (!isValidPort(port)) throw invalid(field, `${field} must be a port number between 1 and 65535`);
    return port;
}

function parseName(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid("name", "name must be a string");
    const name = value.trim();
    if (name.length > MAX_TUNNEL_NAME_LENGTH) throw invalid("name", `name must be at most ${MAX_TUNNEL_NAME_LENGTH} characters`);
    return name || null;
}

// Validates the body of POST /api/servers/:id/tunnels, or of PUT when
// `existing` is given (fields missing from the body keep their value).
// Listening on an address other machines can reach needs
// `confirm_public_bind: true` whenever that address is set or changed.
export function parseTunnelInput(body: Record<string, unknown>, existing?: Tunnel): TunnelFields {
    const has = (field: string) => body[field] !== undefined;

    const fields: TunnelFields = {
        name: has("name") || !existing ? parseName(body.name) : existing.name,
        local_host: has("local_host") || !existing ? parseBindHost(body.local_host) : existing.local_host,
        local_port: has("local_port") || !existing ? parsePort(body.local_port, "local_port") : existing.local_port,
        remote_host: has("remote_host") || !existing ? parseRemoteHost(body.remote_host) : existing.remote_host,
        remote_port: has("remote_port") || !existing ? parsePort(body.remote_port, "remote_port") : existing.remote_port,
        auto_start: existing?.auto_start ?? false
    };
    if (has("auto_start")) {
        if (typeof body.auto_start !== "boolean") throw invalid("auto_start", "auto_start must be true or false");
        fields.auto_start = body.auto_start;
    }

    const exposed = !isLoopbackHost(fields.local_host);
    if (exposed && fields.local_host !== existing?.local_host && body.confirm_public_bind !== true) {
        throw new AppError(
            "PUBLIC_BIND_UNCONFIRMED",
            `Listening on ${formatHostPort(fields.local_host, fields.local_port)} lets other machines on the network use this tunnel. ` +
            "Confirm it (confirm_public_bind: true) or listen on 127.0.0.1.",
            409,
            { local_host: fields.local_host }
        );
    }
    return fields;
}
