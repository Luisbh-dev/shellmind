import { describeTunnel } from "../../shared/tunnels";
import type { AuditInput, Tunnel } from "../../shared/types";
import { recordAudit } from "../db/auditRepo";
import { createLogger } from "../logger";

const log = createLogger("tunnels");

export type TunnelAuditAction = "create" | "update" | "delete" | "start" | "auto-start" | "stop";

// Audit log entry of a tunnel operation (source "ops"): starts carry an exit
// code (0 listening, 1 failed) and the failure in meta.
export function tunnelAuditEntry(
    action: TunnelAuditAction,
    tunnel: Tunnel,
    failure?: { code: string; message: string }
): AuditInput {
    const started = action === "start" || action === "auto-start";
    return {
        serverId: tunnel.server_id,
        source: "ops",
        command: `tunnel ${action} ${describeTunnel(tunnel)}`,
        exitCode: started ? (failure ? 1 : 0) : null,
        meta: {
            tunnelId: tunnel.id,
            name: tunnel.name,
            action,
            ...(failure ? { error: failure.code, message: failure.message } : {})
        }
    };
}

// Records the entry; a failure to write the audit log never fails the operation.
export async function auditTunnel(
    action: TunnelAuditAction,
    tunnel: Tunnel,
    failure?: { code: string; message: string },
    record: (input: AuditInput) => Promise<unknown> = recordAudit
): Promise<void> {
    try {
        await record(tunnelAuditEntry(action, tunnel, failure));
    } catch (err) {
        log.warn(`Could not record "${action}" of tunnel #${tunnel.id} in the audit log`, err);
    }
}
