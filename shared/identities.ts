// W7-S2 identities (Settings > Keychain): credentials several SSH servers
// connect with, kept once. Shared by the backend and the frontend.

// How an identity's fields combine with a server's own (documented in
// server/connections/target.ts): a field saved on the server wins when it is
// set, the identity fills the ones it leaves empty. A server's own private
// key (pasted or a key file) goes with its own passphrase, an identity's key
// with the identity's.

// An identity as GET /api/identities lists it. Secrets never leave the
// backend; the has_* flags (SQLite 0/1) say whether one is stored.
export type IdentitySummary = {
    id: number;
    name: string;
    username: string | null;
    // Private key read from this file (on the machine running the backend) at connect time.
    private_key_path: string | null;
    // Signs in with the keys of the SSH agent (ssh-agent, Pageant, Windows OpenSSH agent).
    use_agent: number | boolean;
    // OpenSSH public key of the stored private key ("ssh-ed25519 AAAA... comment"), when known.
    public_key: string | null;
    // "SHA256:..." of public_key.
    fingerprint: string | null;
    key_type: string | null;
    has_password: number | boolean;
    has_private_key: number | boolean;
    has_passphrase: number | boolean;
    // Servers that connect with it.
    server_count: number;
    created_at: number;
    updated_at: number;
};

// Body of POST /api/identities and PUT /api/identities/:id (PUT replaces the
// non-secret fields). Secrets are write-only like a server's: missing or
// blank keeps the stored one, a clear_* flag removes it. A pasted private key
// must be readable with the passphrase (the stored one when none is given).
// An identity holds either a stored private key or a key file, not both.
export type IdentityInput = {
    name: string;
    username?: string | null;
    private_key_path?: string | null;
    use_agent?: boolean;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    clear_password?: boolean;
    clear_private_key?: boolean;
    clear_passphrase?: boolean;
    // Stores a freshly generated ed25519 key pair (encrypted with
    // `passphrase` when given); the private key is never returned, the
    // answer's public_key is what goes into authorized_keys. On PUT only for
    // an identity without a stored key (409 IDENTITY_KEY_EXISTS: rotate it).
    generate_key?: boolean;
    // Comment of the generated public key; "shellmind:<name>" by default.
    key_comment?: string;
};

// Body of POST /api/identities/assign: the servers given connect with the
// identity from now on (null: with their own credentials only). With
// `clearOwnCredentials` their own saved password, private key, passphrase and
// key file are removed, so the identity's are the ones used (refused with a
// null identityId, which would leave them nothing to sign in with).
export type AssignIdentityInput = {
    identityId: number | null;
    serverIds: number[];
    clearOwnCredentials?: boolean;
};

export type AssignIdentityResult = {
    updated: number[];
    // Not SSH servers (identities only apply to Linux and Windows servers).
    skipped: number[];
};

// 409 IDENTITY_IN_USE (DELETE): the servers still using it.
export type IdentityDependent = { id: number; name: string };

export const IDENTITY_LIMITS = {
    name: 128,
    username: 255,
    privateKeyPath: 1024,
    secret: 65536,
    comment: 128,
    // Servers per install / assign request.
    maxServers: 500
} as const;

// --- SSH agent ---------------------------------------------------------------

// Where the backend found an SSH agent:
//   env              SHELLMIND_SSH_AGENT (a socket / pipe path, or "pageant")
//   ssh-auth-sock    SSH_AUTH_SOCK (ssh-agent, gpg-agent, 1Password, Bitwarden...)
//   windows-openssh  the Windows OpenSSH agent pipe (\\.\pipe\openssh-ssh-agent)
//   pageant          PuTTY's Pageant (Windows)
export type AgentSource = "env" | "ssh-auth-sock" | "windows-openssh" | "pageant";

// Why there is none:
//   disabled        SHELLMIND_SSH_AGENT=off
//   remote-backend  the backend listens beyond this computer (web mode): the agent
//                   would be the server machine's, not the browser user's, so
//                   it is only used when SHELLMIND_SSH_AGENT names it
//   not-found       no SSH_AUTH_SOCK (and no Windows agent)
export type AgentUnavailableReason = "disabled" | "remote-backend" | "not-found";

// Why a located agent did not answer (absent: see `error`):
//   not-running  Pageant is not running
//   timeout      no answer within the time
//   unreachable  nothing listens on the socket / pipe
export type AgentErrorCode = "not-running" | "timeout" | "unreachable";

// GET /api/identities/agent: whether the agent answers and how many keys it holds.
export type AgentStatus =
    | { available: true; source: AgentSource; keys: AgentKey[] }
    | { available: false; source: AgentSource; error: string; errorCode?: AgentErrorCode }
    | { available: false; source: null; reason: AgentUnavailableReason };

export type AgentKey = { type: string; fingerprint: string; comment: string };

// --- Install public key / rotate ----------------------------------------------

// Body of POST /api/identities/:id/install: puts the identity's public key in
// the authorized_keys of each server's user (connecting with the server's
// current credentials), then checks that the key alone signs in.
export type InstallKeyInput = { serverIds: number[] };

// Body of POST /api/identities/:id/rotate: generates a new key pair, installs
// it on every server using the identity (signing in with the current key),
// checks it, and only then replaces the stored key. With `force` the key is
// replaced even when some servers failed (they need another credential then).
// `passphrase` encrypts the new key: omitted keeps the current passphrase,
// blank stores the new key without one. `removeOld` (on unless false): once
// every server signed in with the new key, the previous one is taken out of
// their authorized_keys (signing in with the new key), so a copy of it stops
// working; a forced rotation never removes it.
export type RotateKeyInput = { passphrase?: string; force?: boolean; removeOld?: boolean };

// Taking the previous key out of a server's authorized_keys after a rotation:
//   removed   its lines went
//   absent    it was not there (or the file does not exist)
//   failed    see error / errorCode: it still signs in there
export type RemoveStatus = "removed" | "absent" | "failed";

export type RemoveResult = {
    serverId: number;
    status: RemoveStatus;
    // Lines removed.
    removed?: number;
    file?: string;
    error?: string;
    errorCode?: string;
};

// One server's outcome:
//   installed   the key was added
//   present     the key was already there (nothing written)
//   failed      see error / errorCode
export type InstallStatus = "installed" | "present" | "failed";

export type InstallResult = {
    serverId: number;
    name: string;
    status: InstallStatus;
    // The key alone signed in (only checked after installed / present).
    verified?: boolean;
    // Why it failed, or why the check did not pass (English).
    error?: string;
    errorCode?: string;
    // The remote file that holds the key.
    file?: string;
    // "home-writable": the home directory is writable by others, which sshd's
    // StrictModes rejects keys for.
    warnings?: string[];
};

// Server-Sent Events of the install and rotate streams.
export type InstallEvent =
    | { type: "start"; servers: Array<{ serverId: number; name: string }>; fingerprint: string }
    | { type: "progress"; serverId: number; phase: "installing" | "verifying" }
    | { type: "result"; result: InstallResult }
    // Rotate only: whether the stored key was replaced, then (removeOld) the
    // previous key taken out of each server's authorized_keys.
    | { type: "rotated"; replaced: boolean; fingerprint: string | null }
    | { type: "removed"; result: RemoveResult }
    | { type: "done"; cancelled: boolean }
    | { type: "error"; message: string; code?: string }
    | { type: "ping" };
