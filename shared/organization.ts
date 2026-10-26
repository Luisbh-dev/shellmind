// Server organization shared by the backend and the frontend: importing hosts
// from an OpenSSH client config and moving the configuration between installs
// as JSON (never with secrets).
import type { ServerType } from "./types";

// Something in the SSH config that could not be imported as written. The UI
// translates the code; `detail` is the offending value, shown verbatim.
export type SshConfigWarningCode =
    | "include-unresolved"   // an Include that could not be read (outside ~/.ssh, unsupported pattern, too deep)
    | "include-in-text"      // Include in pasted text: there is no file to read it from
    | "match-ignored"        // Match blocks are not evaluated
    | "proxy-command"        // ProxyCommand is not supported (ProxyJump is)
    | "proxy-jump-chain"     // ProxyJump with several hops: only the last one is used
    | "proxy-jump-unknown"   // the jump host is neither an alias of this file nor a saved server
    | "identity-multiple"    // several IdentityFile lines: the first one is used
    | "unsupported-token"    // a %token that ShellMind cannot expand
    | "invalid-port"
    | "user-default";        // no User: the local user name is used, like ssh does

export type SshConfigWarning = { code: SshConfigWarningCode; detail?: string };

// One `Host` alias, resolved the way OpenSSH resolves it (the first value of
// each option wins, `Host *` defaults included). Wildcard patterns are not hosts.
export type SshConfigEntry = {
    alias: string;
    // HostName, or the alias itself.
    host: string;
    // null: the default SSH port.
    port: number | null;
    user: string | null;
    // First IdentityFile (the key file of the host's identity, W7-S2; `~` is
    // expanded at connect time).
    identityFile: string | null;
    // Last hop of ProxyJump (an alias of this file or the name/host of a saved server).
    proxyJump: string | null;
    // The saved server to jump through: the one the hop names (by name or
    // address) when it is not an alias of this file, or the saved duplicate of
    // the alias it names. null when the jump is an entry to import (or unknown).
    proxyJumpSavedId: number | null;
    // A saved server with the same host, port and user already exists.
    duplicateOf: { id: number; name: string } | null;
    warnings: SshConfigWarning[];
    // W7-S2: IdentityAgent names an agent (anything but "none"): the host
    // signs in with ShellMind's SSH agent. ShellMind has one agent setting
    // (Settings > Keychain), so the socket it names is not kept.
    identityAgent?: boolean;
};

// Body of POST /api/import/ssh-config/preview: without `text` the backend
// reads ~/.ssh/config (and its Include files) of the user it runs as.
export type SshConfigPreviewRequest = { text?: string };

export type SshConfigPreview = {
    // The file that was read, or null for pasted text.
    source: string | null;
    entries: SshConfigEntry[];
    // File-level problems (Includes, Match blocks).
    warnings: SshConfigWarning[];
};

// An entry to create, as previewed; `name` defaults to the alias.
export type SshConfigApplyEntry = {
    alias: string;
    name?: string;
    host: string;
    port?: number | null;
    user?: string | null;
    identityFile?: string | null;
    proxyJump?: string | null;
    // As previewed. When the hop is not an entry of the same request, this
    // saved server is the jump host (null: none, the entry is skipped).
    // Omitted: a saved SSH server with that name or address is looked up.
    proxyJumpSavedId?: number | null;
    // W7-S2: as previewed.
    identityAgent?: boolean;
};

export type SshConfigApplyRequest = {
    entries: SshConfigApplyEntry[];
    // Group of the created servers (none when blank).
    group_name?: string | null;
};

export type ImportSkipReason =
    | "duplicate"       // already saved
    | "invalid"         // refused by validation (detail: the message)
    | "jump-missing"    // its jump host is neither imported nor saved
    | "server-missing"  // a snippet or tunnel of a server that was not imported
    | "unsupported-server"; // a tunnel of a server without SSH (detail: its name)

export type ImportOutcome = { name: string; id?: number; reason?: ImportSkipReason; detail?: string };

export type ImportReport = { created: ImportOutcome[]; skipped: ImportOutcome[] };

// W7-S2: hosts that share a key file (IdentityFile) and the use of the agent
// (IdentityAgent) sign in with one identity, so changing that key is one
// edit. `identities` lists the identities created, and as skipped
// ("duplicate") the saved ones reused: only one that holds nothing but the
// same key file is (never one with a password or a stored key).
export type SshConfigApplyResult = ImportReport & { identities?: ImportReport };

// --- JSON export / import ---------------------------------------------------

export const EXPORT_FORMAT = "shellmind-config";
export const EXPORT_VERSION = 1;

// A saved server without secrets. `ref` identifies it inside the file (jump
// hosts, snippets and tunnels point at it); ids are not kept across installs.
export type ExportedServer = {
    ref: number;
    name: string;
    ip: string;
    type: ServerType;
    username: string | null;
    port: number | null;
    ssh_port: number | null;
    s3_provider: string | null;
    s3_bucket: string | null;
    s3_region: string | null;
    s3_endpoint: string | null;
    s3_access_key: string | null;
    command: string | null;
    cwd: string | null;
    initial_command: string | null;
    cli_preset: string | null;
    domain: string | null;
    private_key_path: string | null;
    jump_ref: number | null;
    group_name: string | null;
    tags: string[];
    color: string | null;
    notes: string | null;
    sort_order: number;
    ftp_secure: boolean;
    // Absent in files exported before favourites existed.
    favorite?: boolean;
    // --- W7-S2 identities ---
    // Name of the identity it connects with (matched by name on import);
    // absent in older files.
    identity?: string | null;
    agent_forward?: boolean;
};

// W7-S2: an identity without any secret (no password, key or passphrase):
// importing it creates the identity when none of that name exists, and its
// secrets are entered again in Settings > Keychain.
export type ExportedIdentity = {
    name: string;
    username: string | null;
    private_key_path: string | null;
    use_agent: boolean;
};

export type ExportedSnippet = {
    name: string;
    command: string;
    description: string | null;
    tags: string[];
    // null: available on every server.
    server_ref: number | null;
};

export type ExportedTunnel = {
    server_ref: number;
    name: string | null;
    local_host: string;
    local_port: number;
    remote_host: string;
    remote_port: number;
    auto_start: boolean;
};

// GET /api/export, and the body of POST /api/import.
export type ExportBundle = {
    format: typeof EXPORT_FORMAT;
    version: typeof EXPORT_VERSION;
    exported_at: string;
    app_version: string;
    servers: ExportedServer[];
    snippets: ExportedSnippet[];
    tunnels: ExportedTunnel[];
    // W7-S2; absent in older files.
    identities?: ExportedIdentity[];
};

// Servers are merged by name + host, snippets by name + command + server,
// tunnels by server + ports + remote host. Imported tunnels never start on
// their own and listen on loopback only.
export type ConfigImportResult = {
    servers: ImportReport;
    snippets: ImportReport;
    tunnels: ImportReport;
    // W7-S2: identities are merged by name (case-insensitive).
    identities?: ImportReport;
    // W7-S2: the connections that asked for credentials saved here, and
    // whether they got them (the import was applied with link_credentials).
    credentials?: { linked: boolean; servers: ImportReviewCredential[] };
};

// W7-S2: an imported connection that would sign in with credentials saved on
// this computer: an identity that already exists here (the file names it),
// or the SSH agent forwarded to the host. The file only names them, so they
// are given only with the user's consent (POST /api/import?link_credentials=1);
// without it the connection is imported without that identity and without
// agent forwarding. An identity the same import creates carries no secret.
export type ImportReviewCredential = {
    // The connection, and the host (host:port) its credentials would go to.
    name: string;
    host: string;
    identity: string;
    // The identity was saved here before (false: created by this import).
    saved: boolean;
    // What the identity signs in with.
    uses: Array<"password" | "key" | "keyFile" | "agent">;
    // The host could use this computer's SSH agent while a terminal is open.
    agent_forward: boolean;
};

// A local console an import would create, with what it runs on this computer.
export type ImportReviewConsole = {
    name: string;
    cli_preset: string | null;
    command: string | null;
    initial_command: string | null;
    cwd: string | null;
};

// A tunnel an import would create (the port it opens on this computer).
export type ImportReviewTunnel = {
    name: string;
    // Name of the server it goes through.
    server: string;
    local_host: string;
    local_port: number;
    remote_host: string;
    remote_port: number;
};

// POST /api/import/preview (same body as POST /api/import): what the import
// would do, nothing saved. `review` lists what needs the user's consent: local
// consoles that run a command, and tunnels. Created outcomes carry no id.
export type ConfigImportPreview = ConfigImportResult & {
    // W7-S2 credentials: what link_credentials would give (absent when nothing).
    review: { consoles: ImportReviewConsole[]; tunnels: ImportReviewTunnel[]; credentials?: ImportReviewCredential[] };
};
