// How identities are summed up in lists and selects.
import type { IdentitySummary } from '@shared/identities';
import { defaultPort, effectivePort } from '@shared/ports';
import type { ServerSummary } from '@shared/types';
import type { TranslateFn } from '@/i18n';

export type Credential = 'password' | 'key' | 'keyFile' | 'agent';

// What an identity signs in with, in the order ssh2 tries them.
export function credentialsOf(identity: IdentitySummary): Credential[] {
    const credentials: Credential[] = [];
    if (identity.has_password) credentials.push('password');
    if (identity.has_private_key) credentials.push('key');
    if (identity.private_key_path) credentials.push('keyFile');
    if (identity.use_agent) credentials.push('agent');
    return credentials;
}

// "deploy · key (ed25519) · SSH agent", for a select's description.
export function describeIdentity(t: TranslateFn, identity: IdentitySummary): string {
    const parts = identity.username ? [identity.username] : [];
    for (const credential of credentialsOf(identity)) {
        parts.push(credential === 'key' && identity.key_type
            ? t('identities.credentials.keyOfType', { type: keyTypeLabel(identity.key_type) })
            : t(`identities.credentials.${credential}`));
    }
    return parts.length ? parts.join(' · ') : t('identities.credentials.none');
}

// "ssh-ed25519" -> "ed25519", "ecdsa-sha2-nistp256" -> "ECDSA 256".
export function keyTypeLabel(type: string): string {
    if (type === 'ssh-ed25519') return 'ed25519';
    if (type === 'ssh-rsa') return 'RSA';
    const ecdsa = /^ecdsa-sha2-nistp(\d+)$/.exec(type);
    if (ecdsa) return `ECDSA ${ecdsa[1]}`;
    return type.replace(/^ssh-/, '');
}

export const isSshServer = (server: ServerSummary) => server.type === 'linux' || server.type === 'windows';

// "user@host:port" as the server signs in over SSH: its own username, else
// its identity's; the port only when it is not 22.
export function serverAddress(server: ServerSummary, identityUsername?: string | null): string {
    const user = server.username?.trim() || identityUsername?.trim() || '';
    const port = effectivePort(server, 'terminal');
    const showPort = port !== null && port !== defaultPort(server.type, 'terminal');
    const host = showPort && server.ip.includes(':') ? `[${server.ip}]` : server.ip;
    return `${user ? `${user}@` : ''}${host}${showPort ? `:${port}` : ''}`;
}

// Servers that sign in with the identity.
export function serversUsing(identityId: number, servers: ServerSummary[]): ServerSummary[] {
    return servers.filter((server) => server.identity_id === identityId);
}

// Whether a server has credentials of its own (they win over the identity's).
export function hasOwnCredentials(server: ServerSummary): boolean {
    return Boolean(server.has_password || server.has_private_key || server.private_key_path);
}
