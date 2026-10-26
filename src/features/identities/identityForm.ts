// The identity editor as data: its state, validation and the request body it
// becomes (IdentityInput). Pure, so it is tested directly.
import type { IdentityInput, IdentitySummary } from '@shared/identities';

// What happens to the private key on save:
//   keep      the stored key stays (edit only)
//   none      no key (a stored one is removed)
//   generate  a new ed25519 pair is generated and stored
//   paste     the pasted key is stored
//   file      the key is read from a file on the machine running ShellMind
export type KeyMode = 'keep' | 'none' | 'generate' | 'paste' | 'file';

export type IdentityForm = {
    name: string;
    username: string;
    password: string;
    removePassword: boolean;
    keyMode: KeyMode;
    privateKey: string;
    keyPath: string;
    comment: string;
    passphrase: string;
    removePassphrase: boolean;
    useAgent: boolean;
};

export type IdentityFormErrors = Partial<Record<'name' | 'privateKey' | 'keyPath', string>>;

export function formFromIdentity(identity: IdentitySummary | null, initialMode: KeyMode = 'none'): IdentityForm {
    return {
        name: identity?.name ?? '',
        username: identity?.username ?? '',
        password: '',
        removePassword: false,
        keyMode: identity ? (identity.has_private_key ? 'keep' : identity.private_key_path ? 'file' : 'none') : initialMode,
        privateKey: '',
        keyPath: identity?.private_key_path ?? '',
        comment: '',
        passphrase: '',
        removePassphrase: false,
        useAgent: Boolean(identity?.use_agent)
    };
}

// The key modes offered: a stored key is kept or replaced by a pasted one or
// a file (a new generated one goes through rotation, which installs it first).
export function keyModes(identity: IdentitySummary | null): KeyMode[] {
    if (identity?.has_private_key) return ['keep', 'paste', 'file', 'none'];
    return ['none', 'generate', 'paste', 'file'];
}

// Whether the passphrase field applies: a key is generated, pasted or read
// from a file. A kept key keeps its passphrase (the backend never re-encrypts
// a stored key; rotating or pasting it again changes it).
export const usesPassphrase = (form: IdentityForm) => form.keyMode !== 'none' && form.keyMode !== 'keep';

export function validateIdentityForm(form: IdentityForm): IdentityFormErrors {
    const errors: IdentityFormErrors = {};
    if (!form.name.trim()) errors.name = 'identities.editor.errors.nameRequired';
    if (form.keyMode === 'paste' && !form.privateKey.trim()) errors.privateKey = 'identities.editor.errors.keyRequired';
    if (form.keyMode === 'file' && !form.keyPath.trim()) errors.keyPath = 'identities.editor.errors.keyPathRequired';
    return errors;
}

export function buildIdentityPayload(form: IdentityForm, initial: IdentitySummary | null): IdentityInput {
    const payload: IdentityInput = {
        name: form.name.trim(),
        username: form.username.trim() || null,
        use_agent: form.useAgent,
        private_key_path: form.keyMode === 'file' ? form.keyPath.trim() || null : null
    };
    if (form.password) payload.password = form.password;
    else if (form.removePassword && initial?.has_password) payload.clear_password = true;

    const storedKey = Boolean(initial?.has_private_key);
    if (form.keyMode === 'paste') payload.privateKey = form.privateKey;
    if (form.keyMode === 'generate') {
        payload.generate_key = true;
        if (form.comment.trim()) payload.key_comment = form.comment.trim();
    }
    if (storedKey && (form.keyMode === 'none' || form.keyMode === 'file' || form.keyMode === 'generate')) payload.clear_private_key = true;

    // A generated key is encrypted with the passphrase typed for it, never
    // with one stored for an earlier key; without a key none is kept.
    const storedPassphrase = Boolean(initial?.has_passphrase);
    if (usesPassphrase(form) && form.passphrase) payload.passphrase = form.passphrase;
    else if (storedPassphrase && ((usesPassphrase(form) && form.removePassphrase) || form.keyMode === 'none' || form.keyMode === 'generate')) payload.clear_passphrase = true;
    return payload;
}
