import { useEffect, useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Field, Input, Modal, PasswordInput } from '@/components/ui';
import { useT } from '@/i18n';

// "DOMAIN\user" or "user" (a UPN, user@domain, is passed as it is).
export function splitAccount(account: string): { username: string; domain: string } {
    const trimmed = account.trim();
    const slash = trimmed.indexOf('\\');
    if (slash > 0) return { domain: trimmed.slice(0, slash), username: trimmed.slice(slash + 1) };
    return { domain: '', username: trimmed };
}

export function joinAccount(username: string, domain: string): string {
    return domain ? `${domain}\\${username}` : username;
}

// Asks for the password of one connection (it is not stored), optionally as
// another user.
export function PasswordDialog({ open, serverName, account, error, onSubmit, onCancel }: {
    open: boolean;
    serverName: string;
    account: string;
    // A failed attempt's message (wrong password...), shown above the fields.
    error?: string | null;
    onSubmit: (credentials: { username: string; domain: string; password: string }) => void;
    onCancel: () => void;
}) {
    const t = useT();
    const formId = useId();
    const [user, setUser] = useState(account);
    const [password, setPassword] = useState('');
    const [problem, setProblem] = useState<'user' | 'password' | null>(null);

    useEffect(() => {
        if (!open) return;
        setUser(account);
        setPassword('');
        setProblem(null);
    }, [open, account]);

    const submit = (event: React.FormEvent) => {
        event.preventDefault();
        const { username, domain } = splitAccount(user);
        if (!username) return setProblem('user');
        if (!password) return setProblem('password');
        const typed = password;
        setPassword('');
        onSubmit({ username, domain, password: typed });
    };

    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={t('rdp.password.title', { name: serverName })}
            description={t('rdp.password.description')}
            icon={<KeyRound className="h-4 w-4" />}
            widthClass="max-w-sm"
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onCancel}>{t('rdp.password.cancel')}</Button>
                    <Button variant="primary" size="sm" type="submit" form={formId}>{t('rdp.password.submit')}</Button>
                </>
            )}
        >
            <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
                {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
                <Field label={t('rdp.password.user')} hint={t('rdp.password.userHint')} error={problem === 'user' ? t('rdp.password.userRequired') : undefined}>
                    <Input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="username" spellCheck={false} {...(account ? {} : { 'data-autofocus': true })} />
                </Field>
                <Field label={t('rdp.password.password')} error={problem === 'password' ? t('rdp.password.required') : undefined}>
                    <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" {...(account ? { 'data-autofocus': true } : {})} />
                </Field>
            </form>
        </Modal>
    );
}
