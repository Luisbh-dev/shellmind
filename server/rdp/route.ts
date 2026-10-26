import { effectivePort } from "../../shared/ports";
import type { ServerSummary } from "../../shared/types";
import { ConnectionTargetError, loadConnectionTarget, loadSshTarget, parseServerId, type RdpTarget, type SshTarget } from "../connections/target";
import { normalizeHost, serversRepo } from "../db/serversRepo";
import { AppError, errorMessage } from "../errors";
import { checkRdpTarget } from "../local/rdp";
import { routeVia } from "../ssh/hostKeys";
import { savedRouteVia } from "../ssh/savedRoute";

// Where the embedded client's connection goes, built from the saved rows
// only: the Windows server's RDP endpoint and, when it has a jump host, the
// SSH server whose connection forwards to it.
export type RdpRoute = {
    target: RdpTarget;
    jump: SshTarget | null;
    // The jump hosts as host:port joined with ">" ("" when direct): part of
    // the identity of a pinned certificate, like for SSH host keys.
    via: string;
};

// `password: false`: the route without the saved password (the gateway never
// needs it; "rdp-open" only when it hands it to the client).
export async function loadRdpRoute(serverId: unknown, options: { password: boolean }): Promise<RdpRoute> {
    const target = await loadConnectionTarget(serverId, "rdp", { password: options.password });
    checkRdpTarget(target);
    const summary = await serversRepo.getSummary(target.serverId);
    const jumpId = summary?.jump_server_id ?? null;
    if (jumpId === null) return { target, jump: null, via: "" };
    let jump: SshTarget;
    try {
        jump = await loadSshTarget(jumpId);
    } catch (err) {
        throw new AppError("JUMP_HOST", `The jump host of "${target.name}" cannot be used: ${errorMessage(err)}`, 400);
    }
    return { target, jump, via: routeVia({ host: target.host, port: target.port, jump }) };
}

// A saved Windows server, for what needs no credentials (its pinned
// certificate, its options): unlike loadRdpRoute it works while the saved
// password cannot be decrypted or the user name is not usable.
export async function loadRdpServer(serverId: unknown): Promise<ServerSummary> {
    const id = parseServerId(serverId);
    const summary = await serversRepo.getSummary(id);
    if (!summary) throw new ConnectionTargetError("SERVER_NOT_FOUND", `Server #${id} does not exist (it may have been deleted).`);
    if (summary.type !== "windows") throw new ConnectionTargetError("UNSUPPORTED_PURPOSE", `A ${summary.type} server does not support rdp connections.`);
    return summary;
}

// The RDP endpoint and jump route a server's certificate is pinned for, as
// loadRdpRoute builds them when it connects.
export async function loadRdpEndpoint(serverId: unknown): Promise<{ serverId: number; host: string; port: number; via: string }> {
    const summary = await loadRdpServer(serverId);
    const port = effectivePort(summary, "rdp");
    if (port === null) throw new ConnectionTargetError("UNSUPPORTED_PURPOSE", `"${summary.name}" has no Remote Desktop port.`);
    const via = summary.jump_server_id === null || summary.jump_server_id === undefined ? "" : await savedRouteVia(summary);
    if (via === null) throw new AppError("JUMP_HOST", `The jump host chain of "${summary.name}" cannot be connected through.`, 400);
    return { serverId: summary.id, host: normalizeHost(summary.ip ?? ""), port, via };
}
