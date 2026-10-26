// The connection form of AddServerModal as data: its state, validation and
// the request body it becomes (ServerInput). Pure, so it is tested directly.
import type { ServerInput, ServerSummary, ServerType } from '@shared/types';
import { CLI_PRESET_KEYS } from '@shared/cliPresets';

export type AuthMethod = 'password' | 'key' | 'keyFile';

export type ServerForm = {
    type: ServerType;
    auth: AuthMethod;
    name: string;
    ip: string;
    username: string;
    port: string;
    ssh_port: string;
    domain: string;
    password: string;
    privateKey: string;
    passphrase: string;
    private_key_path: string;
    ftp_secure: boolean;
    s3_provider: string;
    s3_bucket: string;
    s3_region: string;
    s3_endpoint: string;
    s3_access_key: string;
    s3_secret_key: string;
    command: string;
    cwd: string;
    initial_command: string;
    cli_preset: string;
    // '' = no jump host.
    jump_server_id: string;
    group_name: string;
    tags: string[];
    color: string | null;
    notes: string;
    // --- W7-S2 identities ---
    // '' = the server's own credentials only.
    identity_id: string;
    // With an identity: also keep (and edit) the server's own password and
    // key, which then win over the identity's. Off: they are removed.
    keepOwn: boolean;
    agent_forward: boolean;
};

export type SecretField = 'password' | 'privateKey' | 'passphrase' | 's3_secret_key';

// Stored secrets the user asked to remove (edit mode).
export type SecretRemovals = Record<SecretField, boolean>;
export const NO_REMOVALS: SecretRemovals = { password: false, privateKey: false, passphrase: false, s3_secret_key: false };

export const EMPTY_FORM: ServerForm = {
    type: 'linux',
    auth: 'password',
    name: '',
    ip: '',
    username: '',
    port: '',
    ssh_port: '',
    domain: '',
    password: '',
    privateKey: '',
    passphrase: '',
    private_key_path: '',
    // New FTP connections use TLS unless the user turns it off.
    ftp_secure: true,
    s3_provider: 'aws',
    s3_bucket: '',
    s3_region: 'us-east-1',
    s3_endpoint: '',
    s3_access_key: '',
    s3_secret_key: '',
    command: '',
    cwd: '',
    initial_command: '',
    cli_preset: 'shell',
    jump_server_id: '',
    group_name: '',
    tags: [],
    color: null,
    notes: '',
    identity_id: '',
    keepOwn: false,
    agent_forward: false
};

export const isSshType = (type: ServerType) => type === 'linux' || type === 'windows';

// W7-S2: the server signs in with an identity and none of its own secrets.
export const signsInViaIdentity = (form: Pick<ServerForm, 'type' | 'identity_id' | 'keepOwn'>) =>
    isSshType(form.type) && Boolean(form.identity_id) && !form.keepOwn;

// The edit form of a saved server. Secrets are never sent to the frontend:
// their fields start blank and blank means "keep".
export function formFromServer(server: ServerSummary): ServerForm {
    const text = (value: string | null | undefined) => value ?? '';
    return {
        ...EMPTY_FORM,
        type: server.type,
        auth: server.private_key_path ? 'keyFile' : server.has_private_key ? 'key' : 'password',
        name: server.name,
        ip: server.type === 'local' ? '' : text(server.ip),
        username: text(server.username),
        port: server.port ? String(server.port) : '',
        ssh_port: server.ssh_port ? String(server.ssh_port) : '',
        domain: text(server.domain),
        private_key_path: text(server.private_key_path),
        // A saved FTP server keeps its setting; switching another type to FTP starts secure.
        ftp_secure: server.type === 'ftp' ? Boolean(server.ftp_secure) : true,
        s3_provider: server.s3_provider || 'aws',
        s3_bucket: text(server.s3_bucket),
        s3_region: server.s3_region || 'us-east-1',
        s3_endpoint: text(server.s3_endpoint),
        s3_access_key: text(server.s3_access_key),
        command: text(server.command),
        cwd: text(server.cwd),
        initial_command: text(server.initial_command),
        cli_preset: server.cli_preset || 'shell',
        jump_server_id: server.jump_server_id ? String(server.jump_server_id) : '',
        group_name: text(server.group_name),
        tags: server.tags ?? [],
        color: server.color ?? null,
        notes: text(server.notes),
        identity_id: server.identity_id ? String(server.identity_id) : '',
        // Own credentials saved next to an identity are in use: kept.
        keepOwn: Boolean(server.identity_id) && Boolean(server.has_password || server.has_private_key || server.private_key_path),
        agent_forward: Boolean(server.agent_forward)
    };
}

// Whether the password field is shown whatever the SSH authentication: a
// Windows server's password is also its Remote Desktop credential.
export const passwordAlwaysUsed = (type: ServerType) => type === 'ftp' || type === 'windows';

// Which secrets the form uses for its type and authentication method (none
// of the SSH ones when it signs in with an identity alone).
export function usedSecrets(form: Pick<ServerForm, 'type' | 'auth' | 'identity_id' | 'keepOwn'>): Record<SecretField, boolean> {
    const ssh = isSshType(form.type) && !signsInViaIdentity(form);
    return {
        password: (ssh && form.auth === 'password') || (passwordAlwaysUsed(form.type) && !signsInViaIdentity(form)),
        privateKey: ssh && form.auth === 'key',
        passphrase: ssh && form.auth !== 'password',
        s3_secret_key: form.type === 's3'
    };
}

const STORED_FLAG: Record<SecretField, keyof ServerSummary> = {
    password: 'has_password',
    privateKey: 'has_private_key',
    passphrase: 'has_passphrase',
    s3_secret_key: 'has_s3_secret_key'
};

export function hasStored(server: ServerSummary | null | undefined, field: SecretField): boolean {
    return Boolean(server?.[STORED_FLAG[field]]);
}

// Stored secrets that saving will delete: the ones marked for removal and
// the ones the chosen type / authentication no longer uses.
export function secretsToClear(form: ServerForm, initial: ServerSummary | null | undefined, removals: SecretRemovals): SecretField[] {
    const used = usedSecrets(form);
    return (Object.keys(STORED_FLAG) as SecretField[]).filter((field) =>
        hasStored(initial, field) && (removals[field] || !used[field]) && !form[field]
    );
}

export type FormErrors = Partial<Record<'name' | 'cli_preset' | 'ip' | 'port' | 'ssh_port' | 'username' | 'privateKey' | 'private_key_path'
    | 's3_bucket' | 's3_endpoint' | 's3_access_key' | 's3_secret_key', string>>;

// Error message keys (i18n) of the invalid fields, in form order.
export function validateForm(form: ServerForm, initial: ServerSummary | null | undefined, removals: SecretRemovals): FormErrors {
    const errors: FormErrors = {};
    const ssh = isSshType(form.type);
    const portValid = (value: string) => !value.trim() || (/^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 65535);
    const kept = (field: SecretField) => hasStored(initial, field) && !removals[field];

    if (!form.name.trim()) errors.name = 'addServer.errors.nameRequired';
    // Saved before presets were checked: the backend refuses it until another is chosen.
    if (form.type === 'local' && !CLI_PRESET_KEYS.includes(form.cli_preset)) errors.cli_preset = 'addServer.errors.unknownPreset';
    if ((ssh || form.type === 'ftp') && !form.ip.trim()) errors.ip = 'addServer.errors.hostRequired';
    if ((ssh || form.type === 'ftp') && !portValid(form.port)) errors.port = 'addServer.errors.port';
    if (form.type === 'windows' && !portValid(form.ssh_port)) errors.ssh_port = 'addServer.errors.port';
    // With an identity the username may come from it, and its own key is optional.
    const own = ssh && !signsInViaIdentity(form);
    if (ssh && !form.identity_id && !form.username.trim()) errors.username = 'addServer.errors.usernameRequired';
    if (ssh && !form.identity_id && form.auth === 'key' && !form.privateKey.trim() && !kept('privateKey')) errors.privateKey = 'addServer.errors.keyRequired';
    if (own && form.auth === 'keyFile' && !form.private_key_path.trim()) errors.private_key_path = 'addServer.errors.keyPathRequired';
    if (form.type === 's3') {
        if (!form.s3_bucket.trim()) errors.s3_bucket = 'addServer.errors.bucketRequired';
        if (form.s3_provider !== 'aws' && !form.s3_endpoint.trim()) errors.s3_endpoint = 'addServer.errors.endpointRequired';
        if (!form.s3_access_key.trim()) errors.s3_access_key = 'addServer.errors.accessKeyRequired';
        if (!form.s3_secret_key && !kept('s3_secret_key')) errors.s3_secret_key = 'addServer.errors.secretRequired';
    }
    return errors;
}

const blankToNull = (value: string) => value.trim() || null;
const portOrNull = (value: string) => (value.trim() ? Number(value.trim()) : null);

// The POST/PUT body. Fields that do not apply to the type are sent empty so a
// type change leaves nothing behind; secrets are sent only when typed.
export function buildPayload(form: ServerForm, initial: ServerSummary | null | undefined, removals: SecretRemovals): ServerInput {
    const { type } = form;
    const ssh = isSshType(type);
    const remote = ssh || type === 'ftp';
    const used = usedSecrets(form);
    const payload: ServerInput = {
        type,
        name: form.name.trim(),
        // Local consoles have no host; the column is NOT NULL.
        ip: type === 'local' ? 'local' : type === 's3' ? '' : form.ip.trim(),
        username: remote ? blankToNull(form.username) : null,
        port: remote ? portOrNull(form.port) : null,
        ssh_port: type === 'windows' ? portOrNull(form.ssh_port) : null,
        domain: type === 'windows' ? blankToNull(form.domain) : null,
        private_key_path: ssh && !signsInViaIdentity(form) && form.auth === 'keyFile' ? blankToNull(form.private_key_path) : null,
        jump_server_id: ssh && form.jump_server_id ? Number(form.jump_server_id) : null,
        identity_id: ssh && form.identity_id ? Number(form.identity_id) : null,
        agent_forward: ssh && form.agent_forward,
        ftp_secure: type === 'ftp' && form.ftp_secure,
        s3_provider: type === 's3' ? form.s3_provider : null,
        s3_bucket: type === 's3' ? blankToNull(form.s3_bucket) : null,
        s3_region: type === 's3' && form.s3_provider === 'aws' ? blankToNull(form.s3_region) : null,
        s3_endpoint: type === 's3' && form.s3_provider !== 'aws' ? blankToNull(form.s3_endpoint) : null,
        s3_access_key: type === 's3' ? blankToNull(form.s3_access_key) : null,
        command: type === 'local' && form.cli_preset === 'custom' ? blankToNull(form.command) : null,
        cwd: type === 'local' ? blankToNull(form.cwd) : null,
        initial_command: type === 'local' ? blankToNull(form.initial_command) : null,
        cli_preset: type === 'local' ? form.cli_preset : null,
        group_name: blankToNull(form.group_name),
        tags: form.tags,
        color: form.color,
        notes: blankToNull(form.notes)
    };
    for (const field of ['password', 'privateKey', 'passphrase', 's3_secret_key'] as const) {
        if (used[field] && form[field]) payload[field] = form[field];
    }
    for (const field of secretsToClear(form, initial, removals)) payload[CLEAR_FLAG[field]] = true;
    return payload;
}

const CLEAR_FLAG = {
    password: 'clear_password',
    privateKey: 'clear_private_key',
    passphrase: 'clear_passphrase',
    s3_secret_key: 'clear_s3_secret_key'
} as const satisfies Record<SecretField, keyof ServerInput>;
