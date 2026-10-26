import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { AUTH_TOKEN } from "./config";

// The session token guards every API route (except GET /api/health) and every
// socket.io handshake. Electron and `npm start` pass a fresh one per launch in
// SHELLMIND_AUTH_TOKEN; a self-hosted server without it generates one and
// prints it once at startup.

export type SessionToken = { value: string; generated: boolean };

let sessionToken: SessionToken | undefined;

export function generateToken(): string {
    return randomBytes(32).toString("base64url");
}

export function getSessionToken(): SessionToken {
    sessionToken ??= AUTH_TOKEN
        ? { value: AUTH_TOKEN, generated: false }
        : { value: generateToken(), generated: true };
    return sessionToken;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

// Constant-time comparison; hashing first gives both sides the same length.
export function tokensMatch(expected: string, candidate: unknown): boolean {
    if (typeof candidate !== "string" || !candidate || !expected) return false;
    return timingSafeEqual(digest(expected), digest(candidate));
}

// The token of an `Authorization: Bearer <token>` header.
export function bearerToken(header: string | undefined): string | undefined {
    return /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "")?.[1];
}
