import {
    EXPORT_FORMAT,
    EXPORT_VERSION,
    type ConfigImportPreview,
    type ConfigImportResult,
    type ExportBundle,
    type ExportedIdentity,
    type ExportedServer,
    type ExportedSnippet,
    type ExportedTunnel,
    type ImportOutcome,
    type ImportReport,
    type ImportReviewConsole,
    type ImportReviewCredential,
    type ImportReviewTunnel
} from "../../shared/organization";
import { normalizeCliPreset } from "../../shared/cliPresets";
import { effectivePort } from "../../shared/ports";
import { supportsTunnels } from "../../shared/tunnels";
import type { ServerSummary } from "../../shared/types";
import { recordAudit } from "../db/auditRepo";
import { identitiesRepo, type IdentityUses } from "../db/identitiesRepo";
import { nextSortOrderIn, normalizeHost, serversRepo } from "../db/serversRepo";
import { dbAll, transaction, type DbClient } from "../db/sqlite";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { snippetsRepo } from "../snippets/repo";
import { parseSnippetInput, type ValidSnippet } from "../snippets/validate";
import { tunnelsRepo, type TunnelFields } from "../tunnels/repo";
import { parseTunnelInput } from "../tunnels/validate";
import { APP_VERSION } from "../version";

// The configuration as a portable JSON file: servers (without any secret),
// snippets and tunnels, and (W7-S2) the identities servers connect with, by
// name and without their secrets. Importing merges into what is already
// saved, in one transaction; a preview runs the same import and rolls it back.
//
// W7-S2: a file only names an identity. A server that names one already
// saved here, or asks to forward the SSH agent, would send this computer's
// credentials to whatever host the file says: that link is made only with
// the user's consent (linkCredentials, after the preview listed it in
// review.credentials) and is audited. Without it the server is imported
// without that identity and without forwarding.

const log = createLogger("import");

const MAX_ITEMS = 5000;

type SnippetRow = { id: number; name: string; command: string; description: string | null; tags: string | null; server_id: number | null };
type TunnelRow = {
    server_id: number;
    name: string | null;
    local_host: string;
    local_port: number;
    remote_host: string;
    remote_port: number;
    auto_start: number;
};

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
    } catch {
        return [];
    }
}

function exportServer(server: ServerSummary, identityNames: Map<number, string>): ExportedServer {
    return {
        ref: server.id,
        name: server.name,
        ip: server.ip,
        type: server.type,
        username: server.username ?? null,
        port: server.port ?? null,
        ssh_port: server.ssh_port ?? null,
        s3_provider: server.s3_provider ?? null,
        s3_bucket: server.s3_bucket ?? null,
        s3_region: server.s3_region ?? null,
        s3_endpoint: server.s3_endpoint ?? null,
        s3_access_key: server.s3_access_key ?? null,
        command: server.command ?? null,
        cwd: server.cwd ?? null,
        initial_command: server.initial_command ?? null,
        cli_preset: server.cli_preset ?? null,
        domain: server.domain ?? null,
        private_key_path: server.private_key_path ?? null,
        jump_ref: server.jump_server_id ?? null,
        group_name: server.group_name ?? null,
        tags: server.tags ?? [],
        color: server.color ?? null,
        notes: server.notes ?? null,
        sort_order: server.sort_order ?? 0,
        ftp_secure: Boolean(server.ftp_secure),
        favorite: Boolean(server.favorite),
        identity: server.identity_id ? identityNames.get(server.identity_id) ?? null : null,
        agent_forward: Boolean(server.agent_forward)
    };
}

export async function exportConfig(): Promise<ExportBundle> {
    const identities = await identitiesRepo.listSummaries();
    const identityNames = new Map(identities.map((identity) => [identity.id, identity.name]));
    const servers = await serversRepo.listSummaries();
    const snippets = await dbAll<SnippetRow>("SELECT id, name, command, description, tags, server_id FROM snippets ORDER BY id");
    const tunnels = await dbAll<TunnelRow>(
        "SELECT server_id, name, local_host, local_port, remote_host, remote_port, auto_start FROM tunnels ORDER BY id"
    );
    return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exported_at: new Date().toISOString(),
        app_version: APP_VERSION,
        servers: servers.map((server) => exportServer(server, identityNames)),
        identities: identities.map((identity): ExportedIdentity => ({
            name: identity.name,
            username: identity.username,
            private_key_path: identity.private_key_path,
            use_agent: Boolean(identity.use_agent)
        })),
        snippets: snippets.map((row): ExportedSnippet => ({
            name: row.name,
            command: row.command,
            description: row.description,
            tags: parseTags(row.tags),
            server_ref: row.server_id
        })),
        tunnels: tunnels.map((row): ExportedTunnel => ({
            server_ref: row.server_id,
            name: row.name,
            local_host: row.local_host,
            local_port: row.local_port,
            remote_host: row.remote_host,
            remote_port: row.remote_port,
            auto_start: row.auto_start === 1
        }))
    };
}

// --- Import -------------------------------------------------------------------

type Item = Record<string, unknown>;

type ImportInput = { servers: Item[]; snippets: Item[]; tunnels: Item[]; identities: Item[] };

// What an import created that runs something on this computer, opens a port
// on it or uses its credentials: shown for review before it is applied.
type Review = { consoles: ImportReviewConsole[]; tunnels: ImportReviewTunnel[]; credentials: ImportReviewCredential[] };

type ImportOptions = { linkCredentials: boolean };

// An imported server that signs in with an identity (audited once saved).
export type IdentityLink = { serverId: number; identityId: number; identity: string; saved: boolean; agentForward: boolean };

// An identity a server item can name: `saved` when it existed before the import.
type KnownIdentity = IdentityUses & { saved: boolean };

function invalid(message: string): AppError {
    return new AppError("INVALID_IMPORT", message, 400);
}

function list(body: Item, key: string): Item[] {
    const value = body[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalid(`${key} must be an array`);
    if (value.length > MAX_ITEMS) throw invalid(`${key} has more than ${MAX_ITEMS} items`);
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`${key}[${index}] must be an object`);
        return item as Item;
    });
}

function str(item: Item, key: string): string | null {
    const value = item[key];
    return typeof value === "string" ? value : null;
}

function int(item: Item, key: string): number | null {
    const value = item[key];
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringList(item: Item, key: string): string[] {
    const value = item[key];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const isPort = (value: number | null): value is number => value !== null && value >= 1 && value <= 65535;

const serverKey = (name: string, ip: string) => `${name.trim().toLowerCase()}\u0000${normalizeHost(ip).toLowerCase()}`;

const blankToNull = (value: string | null) => (value && value.trim() ? value.trim() : null);

// An imported tunnel only listens on this computer: a file must not be able
// to expose a remote service to the network (0.0.0.0) behind the user's back.
function loopbackHost(value: string | null): string {
    const host = normalizeHost(value ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return host;
    return "127.0.0.1";
}

function parseInput(body: Item): ImportInput {
    if (body.format !== EXPORT_FORMAT) throw invalid("This file is not a ShellMind configuration export.");
    if (body.version !== EXPORT_VERSION) throw invalid(`Unsupported export version: ${String(body.version)}`);
    return { servers: list(body, "servers"), snippets: list(body, "snippets"), tunnels: list(body, "tunnels"), identities: list(body, "identities") };
}

// W7-S2: identities by name (case-insensitive). One that does not exist yet is
// created from the file's non-secret fields; a file never carries secrets
// (anything else in the item is ignored). Answers name -> identity for the servers.
async function importIdentities(tx: DbClient, items: Item[]): Promise<{ report: ImportReport; known: Map<string, KnownIdentity> }> {
    const report: ImportReport = { created: [], skipped: [] };
    const known = new Map<string, KnownIdentity>();
    for (const item of items) {
        const name = str(item, "name")?.trim() ?? "";
        const key = name.toLowerCase();
        if (!name || known.has(key)) {
            report.skipped.push({ name, reason: name ? "duplicate" : "invalid" });
            continue;
        }
        const existing = await identitiesRepo.findByNameIn(tx, name);
        if (existing !== null) {
            known.set(key, { ...existing, saved: true });
            report.skipped.push({ name, id: existing.id, reason: "duplicate" });
            continue;
        }
        try {
            const privateKeyPath = str(item, "private_key_path");
            const useAgent = item.use_agent === true;
            const id = await identitiesRepo.createIn(tx, { name, username: str(item, "username"), private_key_path: privateKeyPath, use_agent: useAgent });
            const uses: KnownIdentity["uses"] = [...(privateKeyPath?.trim() ? ["keyFile" as const] : []), ...(useAgent ? ["agent" as const] : [])];
            known.set(key, { id, name, uses, saved: false });
            report.created.push({ name, id });
        } catch (err) {
            if (!(err instanceof AppError)) throw err;
            report.skipped.push({ name, reason: "invalid", detail: err.message });
        }
    }
    return { report, known };
}

// The identity a server item names: imported or saved before, else none.
async function identityOf(tx: DbClient, item: Item, known: Map<string, KnownIdentity>): Promise<KnownIdentity | null> {
    const name = str(item, "identity")?.trim();
    if (!name) return null;
    const imported = known.get(name.toLowerCase());
    if (imported) return imported;
    const saved = await identitiesRepo.findByNameIn(tx, name);
    return saved ? { ...saved, saved: true } : null;
}

const isSshItem = (item: Item): item is Item & { type: "linux" | "windows" } => item.type === "linux" || item.type === "windows";

// Where its credentials would go: the SSH host, with the port unless it is 22.
function hostOf(item: Item & { type: "linux" | "windows" }): string {
    const host = normalizeHost(str(item, "ip") ?? "");
    const port = effectivePort({ type: item.type, port: int(item, "port"), ssh_port: int(item, "ssh_port") }, "terminal");
    return port && port !== 22 ? `${host.includes(":") ? `[${host}]` : host}:${port}` : host;
}

// How an imported server signs in. An identity saved here, or forwarding the
// agent, is listed for review and only given with the user's consent; an
// identity this import creates holds no secret and is always linked.
function credentialsFor(item: Item, identity: KnownIdentity | null, options: ImportOptions, review: Review): { identity: KnownIdentity | null; agentForward: boolean } {
    if (!identity || !isSshItem(item)) return { identity: null, agentForward: false };
    const agentForward = item.agent_forward === true && identity.uses.includes("agent");
    if (!identity.saved && !agentForward) return { identity, agentForward: false };
    review.credentials.push({
        name: str(item, "name")?.trim() ?? "",
        host: hostOf(item),
        identity: identity.name,
        saved: identity.saved,
        uses: identity.uses,
        agent_forward: agentForward
    });
    if (options.linkCredentials) return { identity, agentForward };
    return { identity: identity.saved ? null : identity, agentForward: false };
}

// Servers that other servers jump through come first.
function jumpHostsFirst(items: Item[]): Item[] {
    const byRef = new Map<number, Item>();
    for (const item of items) {
        const ref = int(item, "ref");
        if (ref !== null) byRef.set(ref, item);
    }
    const ordered: Item[] = [];
    const visited = new Set<Item>();
    // A loop is cut where it closes; that server's jump host is then missing
    // and it is skipped.
    const visit = (item: Item) => {
        if (visited.has(item)) return;
        visited.add(item);
        const jumpRef = int(item, "jump_ref");
        const jump = jumpRef === null ? undefined : byRef.get(jumpRef);
        if (jump) visit(jump);
        ordered.push(item);
    };
    items.forEach(visit);
    return ordered;
}

// Position of each server in the file's manual order (ties keep file order).
function fileOrder(items: Item[]): Map<Item, number> {
    const sorted = items
        .map((item, index) => ({ item, index, order: int(item, "sort_order") ?? 0 }))
        .sort((a, b) => a.order - b.order || a.index - b.index);
    return new Map(sorted.map(({ item }, position) => [item, position]));
}

function serverBody(item: Item, jumpId: number | null, sortOrder: number, identityId: number | null, agentForward: boolean): Record<string, unknown> {
    // serversRepo validates everything (type, ports, lengths).
    return {
        name: str(item, "name"),
        ip: str(item, "ip") ?? "",
        type: str(item, "type"),
        username: str(item, "username"),
        port: int(item, "port"),
        ssh_port: int(item, "ssh_port"),
        s3_provider: str(item, "s3_provider"),
        s3_bucket: str(item, "s3_bucket"),
        s3_region: str(item, "s3_region"),
        s3_endpoint: str(item, "s3_endpoint"),
        s3_access_key: str(item, "s3_access_key"),
        command: str(item, "command"),
        cwd: str(item, "cwd"),
        initial_command: str(item, "initial_command"),
        cli_preset: str(item, "cli_preset"),
        domain: str(item, "domain"),
        private_key_path: str(item, "private_key_path"),
        jump_server_id: jumpId,
        group_name: str(item, "group_name"),
        tags: stringList(item, "tags"),
        color: str(item, "color"),
        notes: str(item, "notes"),
        sort_order: sortOrder,
        ftp_secure: item.ftp_secure === true,
        favorite: item.favorite === true,
        identity_id: identityId,
        agent_forward: agentForward
    };
}

async function importServers(
    tx: DbClient,
    items: Item[],
    idByRef: Map<number, number>,
    review: Review,
    identities: Map<string, KnownIdentity>,
    options: ImportOptions,
    links: IdentityLink[]
): Promise<ImportReport> {
    const report: ImportReport = { created: [], skipped: [] };
    const rows = await tx.all<{ id: number; name: string; ip: string }>("SELECT id, name, ip FROM servers");
    const existing = new Map(rows.map((server) => [serverKey(server.name, server.ip), server.id]));
    // Imported servers keep their relative order, after the saved ones.
    const base = await nextSortOrderIn(tx);
    const order = fileOrder(items);

    for (const item of jumpHostsFirst(items)) {
        const name = str(item, "name") ?? "";
        const ref = int(item, "ref");
        const known = existing.get(serverKey(name, str(item, "ip") ?? ""));
        if (known !== undefined) {
            if (ref !== null) idByRef.set(ref, known);
            report.skipped.push({ name, id: known, reason: "duplicate" });
            continue;
        }

        const jumpRef = int(item, "jump_ref");
        const jumpId = jumpRef === null ? null : idByRef.get(jumpRef) ?? null;
        if (jumpRef !== null && jumpId === null) {
            report.skipped.push({ name, reason: "jump-missing" });
            continue;
        }

        try {
            // Listed for review only once the server passed validation.
            const pending: Review = { consoles: [], tunnels: [], credentials: [] };
            const credentials = credentialsFor(item, await identityOf(tx, item, identities), options, pending);
            const id = await serversRepo.createIn(tx, serverBody(item, jumpId, base + (order.get(item) ?? 0), credentials.identity?.id ?? null, credentials.agentForward));
            review.credentials.push(...pending.credentials);
            if (credentials.identity) {
                const { id: identityId, name: identity, saved } = credentials.identity;
                links.push({ serverId: id, identityId, identity, saved, agentForward: credentials.agentForward });
            }
            if (ref !== null) idByRef.set(ref, id);
            existing.set(serverKey(name, str(item, "ip") ?? ""), id);
            report.created.push({ name, id });
            const command = blankToNull(str(item, "command"));
            const initialCommand = blankToNull(str(item, "initial_command"));
            if (str(item, "type") === "local" && (command || initialCommand)) {
                review.consoles.push({
                    name,
                    cli_preset: normalizeCliPreset(str(item, "cli_preset") ?? ""),
                    command,
                    initial_command: initialCommand,
                    cwd: blankToNull(str(item, "cwd"))
                });
            }
        } catch (err) {
            if (!(err instanceof AppError)) throw err;
            report.skipped.push({ name, reason: "invalid", detail: err.message });
        }
    }
    return report;
}

// A server reference of a snippet/tunnel: null (no server), an id, or
// undefined when it points at a server that was not imported.
function mappedServer(item: Item, idByRef: Map<number, number>): number | null | undefined {
    const ref = int(item, "server_ref");
    return ref === null ? null : idByRef.get(ref);
}

async function importSnippets(tx: DbClient, items: Item[], idByRef: Map<number, number>): Promise<ImportReport> {
    const report: ImportReport = { created: [], skipped: [] };
    const rows = await tx.all<{ name: string; command: string; server_id: number | null }>("SELECT name, command, server_id FROM snippets");
    const keyOf = (name: string, command: string, serverId: number | null) => JSON.stringify([name, command, serverId]);
    const existing = new Set(rows.map((row) => keyOf(row.name, row.command, row.server_id)));

    for (const item of items) {
        const outcome: ImportOutcome = { name: str(item, "name")?.trim() ?? "" };
        // The snippet editor's own rules (lengths, tags), so an import never
        // saves a snippet the library could not.
        let snippet: ValidSnippet | null = null;
        try {
            snippet = parseSnippetInput({ name: item.name, command: item.command, description: item.description, tags: stringList(item, "tags") });
        } catch {
            snippet = null;
        }
        const serverId = mappedServer(item, idByRef);
        if (!snippet) {
            report.skipped.push({ ...outcome, reason: "invalid" });
        } else if (serverId === undefined) {
            report.skipped.push({ ...outcome, reason: "server-missing" });
        } else if (existing.has(keyOf(snippet.name, snippet.command, serverId))) {
            report.skipped.push({ ...outcome, reason: "duplicate" });
        } else {
            const created = await snippetsRepo.createIn(tx, { ...snippet, server_id: serverId });
            existing.add(keyOf(snippet.name, snippet.command, serverId));
            report.created.push({ ...outcome, id: created.id });
        }
    }
    return report;
}

// Tunnels are imported stopped (auto_start off) and listening on loopback
// only, whatever the file says; the user can change both afterwards. Only SSH
// servers have tunnels, as in the tunnel editor.
async function importTunnels(tx: DbClient, items: Item[], idByRef: Map<number, number>, review: Review): Promise<ImportReport> {
    const report: ImportReport = { created: [], skipped: [] };
    const rows = await tx.all<TunnelRow>("SELECT server_id, local_port, remote_host, remote_port FROM tunnels");
    const keyOf = (serverId: number, localPort: number, remoteHost: string, remotePort: number) =>
        JSON.stringify([serverId, localPort, remoteHost.toLowerCase(), remotePort]);
    const existing = new Set(rows.map((row) => keyOf(row.server_id, row.local_port, row.remote_host, row.remote_port)));
    const servers = new Map((await tx.all<{ id: number; name: string; type: string }>("SELECT id, name, type FROM servers")).map((row) => [row.id, row]));

    for (const item of items) {
        const localPort = int(item, "local_port");
        const remotePort = int(item, "remote_port");
        const remoteHost = normalizeHost(str(item, "remote_host") ?? "");
        const name = str(item, "name")?.trim() || `${localPort ?? "?"} → ${remoteHost || "?"}:${remotePort ?? "?"}`;
        // The tunnel editor's own rules, on a loopback address and stopped.
        let fields: TunnelFields | null = null;
        if (isPort(localPort) && isPort(remotePort) && remoteHost) {
            try {
                fields = parseTunnelInput({
                    name: item.name,
                    local_host: loopbackHost(str(item, "local_host")),
                    local_port: localPort,
                    remote_host: remoteHost,
                    remote_port: remotePort
                });
            } catch {
                fields = null;
            }
        }
        const serverId = mappedServer(item, idByRef);
        const server = serverId == null ? undefined : servers.get(serverId);
        if (!fields) {
            report.skipped.push({ name, reason: "invalid" });
        } else if (serverId == null || !server) {
            report.skipped.push({ name, reason: "server-missing" });
        } else if (!supportsTunnels(server.type)) {
            // The Tunnels tab could neither list nor delete it.
            report.skipped.push({ name, reason: "unsupported-server", detail: server.name });
        } else if (existing.has(keyOf(serverId, fields.local_port, fields.remote_host, fields.remote_port))) {
            report.skipped.push({ name, reason: "duplicate" });
        } else {
            const id = await tunnelsRepo.createIn(tx, serverId, { ...fields, auto_start: false });
            existing.add(keyOf(serverId, fields.local_port, fields.remote_host, fields.remote_port));
            report.created.push({ name, id });
            review.tunnels.push({
                name,
                server: server.name,
                local_host: fields.local_host,
                local_port: fields.local_port,
                remote_host: fields.remote_host,
                remote_port: fields.remote_port
            });
        }
    }
    return report;
}

type ImportRun = ConfigImportResult & { review: Review; links: IdentityLink[] };

async function runImport(tx: DbClient, input: ImportInput, options: ImportOptions): Promise<ImportRun> {
    const idByRef = new Map<number, number>();
    const review: Review = { consoles: [], tunnels: [], credentials: [] };
    const links: IdentityLink[] = [];
    const identities = await importIdentities(tx, input.identities);
    const servers = await importServers(tx, input.servers, idByRef, review, identities.known, options, links);
    const snippets = await importSnippets(tx, input.snippets, idByRef);
    const tunnels = await importTunnels(tx, input.tunnels, idByRef, review);
    return { servers, snippets, tunnels, identities: identities.report, review, links };
}

// One audit entry (source "identity") per imported server that signs in with
// an identity: whether it was saved here before, and agent forwarding.
export async function auditIdentityLinks(links: IdentityLink[]): Promise<void> {
    for (const link of links) {
        try {
            await recordAudit({
                serverId: link.serverId,
                source: "identity",
                command: `import: sign in with ${link.saved ? "saved" : "new"} identity "${link.identity}"${link.agentForward ? " (SSH agent forwarded)" : ""}`,
                meta: { action: "import", identityId: link.identityId, saved: link.saved, agentForward: link.agentForward }
            });
        } catch (err) {
            log.warn(`Could not record the identity of imported server #${link.serverId} in the audit log: ${errorMessage(err)}`);
        }
    }
}

// Thrown to roll the preview's transaction back with its result.
class PreviewRollback extends Error {
    constructor(readonly preview: ImportRun) {
        super("preview");
    }
}

const withoutIds = (report: ImportReport): ImportReport => ({
    created: report.created.map(({ name }) => ({ name })),
    skipped: report.skipped
});

// What importing `body` would do, without saving anything: the same checks
// and merge as importConfig(), plus what it would run or open locally.
export async function previewConfigImport(body: Item): Promise<ConfigImportPreview> {
    const input = parseInput(body);
    try {
        await transaction(async (tx) => {
            throw new PreviewRollback(await runImport(tx, input, { linkCredentials: false }));
        });
    } catch (err) {
        if (!(err instanceof PreviewRollback)) throw err;
        const { servers, snippets, tunnels, identities, review: { consoles, tunnels: openedTunnels, credentials } } = err.preview;
        return {
            servers: withoutIds(servers),
            snippets: withoutIds(snippets),
            tunnels: withoutIds(tunnels),
            ...(identities ? { identities: withoutIds(identities) } : {}),
            review: { consoles, tunnels: openedTunnels, ...(credentials.length ? { credentials } : {}) }
        };
    }
    throw new Error("The import preview did not roll back");
}

// `linkCredentials`: the user consented to what the preview listed in
// review.credentials. It comes with the request, never from the file.
export async function importConfig(body: Item, options: ImportOptions = { linkCredentials: false }): Promise<ConfigImportResult> {
    const input = parseInput(body);
    const { servers, snippets, tunnels, identities, review, links } = await transaction((tx) => runImport(tx, input, options));
    await auditIdentityLinks(links);
    const asked = review.credentials.length;
    log.info(
        `Configuration import: servers ${servers.created.length}/${input.servers.length}, ` +
        `snippets ${snippets.created.length}/${input.snippets.length}, tunnels ${tunnels.created.length}/${input.tunnels.length}, ` +
        `identities ${identities?.created.length ?? 0}/${input.identities.length} created` +
        (asked ? `, saved credentials ${options.linkCredentials ? "given to" : "withheld from"} ${asked} server(s)` : "")
    );
    return {
        servers,
        snippets,
        tunnels,
        identities,
        ...(asked ? { credentials: { linked: options.linkCredentials, servers: review.credentials } } : {})
    };
}
