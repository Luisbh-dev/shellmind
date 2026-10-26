import { DEBUG, LOG_LEVEL } from "./config";

// Leveled logging for the backend. Lines go to stdout (info, debug) or stderr
// (warn, error); the Electron shell captures both into server.log, so nothing
// that identifies a secret may be logged: pass request bodies, connection
// configs and similar objects through redact() first.

export type LogLevel = "error" | "warn" | "info" | "debug";

const SEVERITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function isLogLevel(value: string): value is LogLevel {
    return Object.prototype.hasOwnProperty.call(SEVERITY, value);
}

const activeLevel: LogLevel = DEBUG ? "debug" : isLogLevel(LOG_LEVEL) ? LOG_LEVEL : "info";

export function isLogLevelEnabled(level: LogLevel): boolean {
    return SEVERITY[level] <= SEVERITY[activeLevel];
}

export interface Logger {
    error(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    info(message: string, ...details: unknown[]): void;
    debug(message: string, ...details: unknown[]): void;
}

// console is looked up on every call so test spies installed later still apply.
function write(level: LogLevel, scope: string, message: string, details: unknown[]) {
    if (!isLogLevelEnabled(level)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`;
    if (level === "error") console.error(line, ...details);
    else if (level === "warn") console.warn(line, ...details);
    else console.log(line, ...details);
}

export function createLogger(scope: string): Logger {
    return {
        error: (message, ...details) => write("error", scope, message, details),
        warn: (message, ...details) => write("warn", scope, message, details),
        info: (message, ...details) => write("info", scope, message, details),
        debug: (message, ...details) => write("debug", scope, message, details)
    };
}

export const REDACTED = "[redacted]";

// Field names whose values are secrets: passwords, keys, tokens, cookies.
const SECRET_FIELD = /pass(word|phrase)?|secret|token|private_?key|api_?key|authorization|cookie|credential|data_?key/i;
const BEARER = /\b(bearer\s+)[\w.~+/=-]+/gi;
const MAX_DEPTH = 8;

// Returns a copy of `value` that is safe to log: string and binary values of
// secret-looking fields in plain objects and arrays are replaced with
// "[redacted]" (at any depth) and bearer tokens inside strings are masked.
// Other objects (Errors, class instances) are returned unchanged; keep their
// messages free of secrets at the source.
export function redact<T>(value: T): T {
    return redactValue(value, 0, new Set()) as T;
}

function isPlainContainer(value: object): boolean {
    const proto = Object.getPrototypeOf(value);
    return Array.isArray(value) || proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
    if (typeof value === "string") return value.replace(BEARER, `$1${REDACTED}`);
    if (!value || typeof value !== "object" || !isPlainContainer(value)) return value;
    if (ancestors.has(value)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[truncated]";

    ancestors.add(value);
    let copy: unknown;
    if (Array.isArray(value)) {
        copy = value.map(item => redactValue(item, depth + 1, ancestors));
    } else {
        const fields: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(value)) {
            const secret = SECRET_FIELD.test(key) && (typeof field === "string" ? field !== "" : ArrayBuffer.isView(field));
            fields[key] = secret ? REDACTED : redactValue(field, depth + 1, ancestors);
        }
        copy = fields;
    }
    ancestors.delete(value);
    return copy;
}
