import { AUDIT_RETENTION_DAYS, type AuditRetentionDays, type AuditSettings } from "../../shared/types";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { auditRepo } from "./auditRepo";
import { settingsRepo } from "./settingsRepo";

// How long the audit log keeps entries. Every AI run, snippet, multi-exec and
// ops action adds one, so without a limit the table (and every search of it)
// grows for as long as the app is used. The age limit is a setting; the
// newest MAX_AUDIT_ENTRIES are kept whatever it says.

const log = createLogger("audit");

export const AUDIT_RETENTION_KEY = "AUDIT_RETENTION_DAYS";
export const DEFAULT_AUDIT_RETENTION_DAYS: AuditRetentionDays = 90;
export const MAX_AUDIT_ENTRIES = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_PRUNE_INTERVAL_MS = DAY_MS;

export function isAuditRetentionDays(value: unknown): value is AuditRetentionDays {
    return typeof value === "number" && (AUDIT_RETENTION_DAYS as readonly number[]).includes(value);
}

export async function getAuditSettings(): Promise<AuditSettings> {
    const raw = await settingsRepo.get(AUDIT_RETENTION_KEY);
    const stored = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return {
        retentionDays: isAuditRetentionDays(stored) ? stored : DEFAULT_AUDIT_RETENTION_DAYS,
        maxEntries: MAX_AUDIT_ENTRIES
    };
}

export async function setAuditRetention(days: unknown): Promise<AuditSettings> {
    if (!isAuditRetentionDays(days)) {
        throw new AppError("INVALID_AUDIT", `retentionDays must be one of: ${AUDIT_RETENTION_DAYS.join(", ")} (0 keeps entries without an age limit)`, 400, { field: "retentionDays" });
    }
    await settingsRepo.set(AUDIT_RETENTION_KEY, String(days));
    return getAuditSettings();
}

// Applies the policy now: drops the entries older than the retention period
// and those beyond the newest MAX_AUDIT_ENTRIES. Returns how many went.
export async function pruneAuditLog(now = Date.now()): Promise<number> {
    const { retentionDays, maxEntries } = await getAuditSettings();
    const expired = retentionDays > 0 ? await auditRepo.pruneOlderThan(now - retentionDays * DAY_MS) : 0;
    const removed = expired + await auditRepo.pruneBeyond(maxEntries);
    if (removed > 0) log.info(`Pruned ${removed} audit log entr${removed === 1 ? "y" : "ies"} (kept ${retentionDays > 0 ? `${retentionDays} days` : "without an age limit"}, at most ${maxEntries})`);
    return removed;
}

// Prunes at startup and then once a day. Returns the function that stops it.
export function startAuditRetention(): () => void {
    const run = () => {
        pruneAuditLog().catch((err) => log.warn(`Could not prune the audit log: ${errorMessage(err)}`));
    };
    run();
    const timer = setInterval(run, AUDIT_PRUNE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
