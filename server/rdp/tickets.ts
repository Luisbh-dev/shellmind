import { createHash, randomBytes, randomUUID } from "crypto";
import type { RdpStatusEvent } from "../../shared/rdp";

// One-time tickets for the gateway WebSocket. A browser cannot put the
// session token in a WebSocket handshake, so the page asks for a ticket over
// its authenticated socket ("rdp-open") and names it in the gateway URL and
// in the RDCleanPath request. A ticket is bound to one saved server, works
// once, and expires quickly when unused.

export const TICKET_TTL_MS = 30_000;
// Tickets waiting to be used, overall and per socket.
const MAX_PENDING = 64;
const MAX_PENDING_PER_OWNER = 4;

export type RdpTicket = {
    // Also the id of the gateway session it opens.
    id: string;
    token: string;
    serverId: number;
    // The socket that asked for it: told about the session ("rdp-status").
    owner: string;
    // Who the client signs in as (for the audit log).
    username: string;
    domain: string;
    expiresAt: number;
    report: (event: RdpStatusEvent) => void;
};

export class TicketLimitError extends Error {
    readonly code = "RDP_BUSY";
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export class TicketBook {
    // By the digest of the token: the lookup never compares secrets.
    private readonly pending = new Map<string, RdpTicket>();

    constructor(private readonly ttlMs = TICKET_TTL_MS, private readonly now = () => Date.now()) {}

    issue(input: Omit<RdpTicket, "id" | "token" | "expiresAt">): RdpTicket {
        this.prune();
        const owned = [...this.pending.values()].filter((ticket) => ticket.owner === input.owner).length;
        if (this.pending.size >= MAX_PENDING || owned >= MAX_PENDING_PER_OWNER) {
            throw new TicketLimitError("Too many Remote Desktop connections are being opened at once; try again in a moment.");
        }
        const ticket: RdpTicket = { ...input, id: randomUUID(), token: randomBytes(32).toString("base64url"), expiresAt: this.now() + this.ttlMs };
        this.pending.set(digest(ticket.token), ticket);
        return ticket;
    }

    // The ticket for `token`, used up by this call; null when it does not
    // exist, was used already or expired (`onExpired` gets one that expired
    // and was not pruned yet, so its page can be told why).
    claim(token: string, onExpired?: (ticket: RdpTicket) => void): RdpTicket | null {
        const key = digest(token);
        const ticket = this.pending.get(key);
        if (!ticket) return null;
        this.pending.delete(key);
        if (ticket.expiresAt > this.now()) return ticket;
        onExpired?.(ticket);
        return null;
    }

    // Drops the unused tickets of a socket that went away, or only the one
    // with id `id` (its connection was cancelled); says whether one was dropped.
    revoke(owner: string, id?: string): boolean {
        let dropped = false;
        for (const [key, ticket] of this.pending) {
            if (ticket.owner === owner && (id === undefined || ticket.id === id)) {
                this.pending.delete(key);
                dropped = true;
            }
        }
        return dropped;
    }

    get size(): number {
        this.prune();
        return this.pending.size;
    }

    private prune(): void {
        const now = this.now();
        for (const [key, ticket] of this.pending) {
            if (ticket.expiresAt <= now) this.pending.delete(key);
        }
    }
}

export const rdpTickets = new TicketBook();
