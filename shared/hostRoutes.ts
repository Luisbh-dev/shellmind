// The jump route a host key is pinned for (server/ssh/hostKeys.ts routeVia):
// "host:port" of every jump host from the first hop, joined with ">", and ""
// for a server reached directly. Worked out from the saved servers here too,
// so the backend shows a server's own pin without building its connection
// target and the known-hosts list can name each pin's route and servers.
import { effectivePort } from "./ports";
import type { ServerSummary } from "./types";

export const MAX_JUMP_HOPS = 5;

const ROUTE_SEPARATOR = ">";

export type RouteServer = Pick<ServerSummary, "id" | "ip" | "type" | "port" | "ssh_port" | "jump_server_id">;

// Addresses are saved without spaces (pasted ones often carry no-break spaces).
export function normalizeHost(value: string): string {
    return value.replace(/[\s\u00A0]+/g, "");
}

// host:port of a saved SSH server, as a hop of a route.
function sshEndpoint(server: RouteServer): string {
    return `${normalizeHost(server.ip ?? "")}:${effectivePort(server, "terminal")}`;
}

// The route of `server` through its saved jump servers. null when the chain
// cannot be connected through (it loops, it is longer than MAX_JUMP_HOPS, or
// a jump server is missing or no SSH server), so no key is pinned for it.
export function savedJumpRoute(server: Pick<RouteServer, "id" | "jump_server_id">, lookup: (id: number) => RouteServer | undefined): string | null {
    const hops: string[] = [];
    const seen = new Set([server.id]);
    for (let jumpId = server.jump_server_id ?? null; jumpId !== null;) {
        if (seen.has(jumpId) || hops.length >= MAX_JUMP_HOPS) return null;
        seen.add(jumpId);
        const jump = lookup(jumpId);
        if (!jump || (jump.type !== "linux" && jump.type !== "windows")) return null;
        hops.unshift(sshEndpoint(jump));
        jumpId = jump.jump_server_id ?? null;
    }
    return hops.join(ROUTE_SEPARATOR);
}

// The hops of a route, first one first ([] for a direct connection).
export function routeHops(via: string | null | undefined): string[] {
    return via ? via.split(ROUTE_SEPARATOR) : [];
}
