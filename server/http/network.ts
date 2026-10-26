import type { IncomingHttpHeaders } from "http";
import type { RequestHandler } from "express";
import { EXTRA_ALLOWED_HOSTS, EXTRA_ALLOWED_ORIGINS } from "../config";
import { createLogger } from "../logger";
import { isAllowedOrigin } from "./origin";
import { errorBody } from "./respond";

const log = createLogger("network");

// DNS rebinding defence: a page on an attacker's domain that resolves to
// 127.0.0.1 is same-origin with the backend, so CORS never applies to it, but
// its requests still carry the attacker's name in the Host header. Only
// loopback names, ALLOWED_HOSTS and the hosts of ALLOWED_ORIGINS are served.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

type HostPattern = { hostname: string; port: string | null };

function parseHost(value: string): HostPattern | null {
    try {
        const url = new URL(`http://${value}`);
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
        return { hostname: url.hostname, port: url.port };
    } catch {
        return null;
    }
}

function hostFromOrigin(origin: string): HostPattern | null {
    try {
        return { hostname: new URL(origin).hostname, port: null };
    } catch {
        return null;
    }
}

// A pattern without a port accepts the name on any port.
const ALLOWED_HOST_PATTERNS: HostPattern[] = [
    ...EXTRA_ALLOWED_HOSTS.map(entry => {
        const parsed = parseHost(entry);
        return parsed && { hostname: parsed.hostname, port: /:\d+$/.test(entry) ? parsed.port : null };
    }),
    ...EXTRA_ALLOWED_ORIGINS.map(hostFromOrigin)
].filter((pattern): pattern is HostPattern => pattern !== null);

// The parsed Host header when it may be served, else null.
function allowedHost(hostHeader: string | undefined): HostPattern | null {
    if (!hostHeader) return null;
    const host = parseHost(hostHeader.trim().toLowerCase());
    if (!host) return null;
    if (LOOPBACK_HOSTNAMES.has(host.hostname)) return host;
    const listed = ALLOWED_HOST_PATTERNS.some(pattern =>
        pattern.hostname === host.hostname && (pattern.port === null || pattern.port === host.port)
    );
    return listed ? host : null;
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
    return allowedHost(hostHeader) !== null;
}

// Whether `origin` is the origin of the server the request was sent to (Host).
// Browsers send Origin on every WebSocket handshake and non-GET fetch, also to
// their own origin, so the UI served by `npm run serve` under an ALLOWED_HOSTS
// name must be accepted without listing it in ALLOWED_ORIGINS as well. A
// Host without a port means the default port of the page's scheme.
function isSameOrigin(origin: string, host: HostPattern): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    return url.hostname === host.hostname && (url.port || defaultPort) === (host.port || defaultPort);
}

export type Rejection = "Host not allowed" | "Origin not allowed";

const REJECTION_CODE: Record<Rejection, string> = {
    "Host not allowed": "HOST_NOT_ALLOWED",
    "Origin not allowed": "ORIGIN_NOT_ALLOWED"
};

// Why a request must be refused, or null when its Host and Origin are fine.
export function requestRejection(headers: IncomingHttpHeaders): Rejection | null {
    const host = allowedHost(headers.host);
    if (!host) return "Host not allowed";
    const { origin } = headers;
    if (isAllowedOrigin(origin) || (origin !== undefined && isSameOrigin(origin, host))) return null;
    return "Origin not allowed";
}

// Rejects (403) instead of merely leaving out the CORS headers: a disallowed
// cross-site request would otherwise still run with its side effects.
export function networkGuard(): RequestHandler {
    return (req, res, next) => {
        const rejection = requestRejection(req.headers);
        if (!rejection) return next();
        log.warn(`${rejection}: ${req.method} ${req.path} (host ${JSON.stringify(req.headers.host ?? "")}, origin ${JSON.stringify(req.headers.origin ?? "")})`);
        res.status(403).json(errorBody(REJECTION_CODE[rejection], rejection));
    };
}
