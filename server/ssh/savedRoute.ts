import { MAX_JUMP_HOPS, savedJumpRoute, type RouteServer } from "../../shared/hostRoutes";
import type { ServerSummary } from "../../shared/types";
import { serversRepo } from "../db/serversRepo";

// The jump route of a saved SSH server, as routeVia() (hostKeys.ts) makes it
// from the server's connection target, read from the saved rows without
// decrypting any secret: the route a host key is pinned for. null when the
// chain cannot be connected through (it loops, it is too long, or a jump
// server is missing or is no SSH server), so no key can be pinned for it.
export async function savedRouteVia(server: Pick<ServerSummary, "id" | "jump_server_id">): Promise<string | null> {
    // The chain's rows, one more than a route may have (so a longer one shows).
    const rows = new Map<number, RouteServer>();
    for (let jumpId = server.jump_server_id ?? null; jumpId !== null && !rows.has(jumpId) && rows.size <= MAX_JUMP_HOPS;) {
        const jump = await serversRepo.getSummary(jumpId);
        if (!jump) break;
        rows.set(jumpId, jump);
        jumpId = jump.jump_server_id ?? null;
    }
    return savedJumpRoute(server, (id) => rows.get(id));
}
