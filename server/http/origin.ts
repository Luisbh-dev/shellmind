import { ALLOW_FILE_ORIGIN, EXTRA_ALLOWED_ORIGINS } from "../config";

// Browser pages from arbitrary origins must not be able to read this API or
// drive the socket (credential/command access). Allowed: requests with no
// Origin (curl, same-origin GETs, the desktop app's fetches), localhost on any
// port (Vite dev, `npm start`), the origins listed in the ALLOWED_ORIGINS env
// var (comma-separated, for web deploys) and, for the desktop backend only,
// the origins of its file:// page (see ALLOW_FILE_ORIGIN).
const FILE_PAGE_ORIGINS = new Set(["file://", "null"]);

export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    if (FILE_PAGE_ORIGINS.has(origin)) return ALLOW_FILE_ORIGIN;

    try {
        const { hostname } = new URL(origin);
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
            return true;
        }
    } catch {
        return false;
    }

    return EXTRA_ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""));
}

export const corsOriginCheck = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    callback(null, isAllowedOrigin(origin));
};
