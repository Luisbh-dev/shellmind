// W7-S2: the part of Settings › Data › Import that concerns credentials saved
// on this computer. A configuration file only names identities; the import
// gives an imported host a saved identity (or this computer's SSH agent,
// forwarded) only when the user consents here.
import { KeyRound, ShieldAlert } from 'lucide-react';
import type { ConfigImportResult, ImportReviewCredential } from '@shared/organization';
import { Badge, Checkbox } from '@/components/ui';
import { useT } from '@/i18n';

interface ImportCredentialsReviewProps {
    items: ImportReviewCredential[];
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

export function ImportCredentialsReview({ items, checked, onChange, disabled }: ImportCredentialsReviewProps) {
    const t = useT();
    if (items.length === 0) return null;
    return (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-100">
            <p className="flex items-start gap-1.5 font-medium">
                <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                {t('identities.import.reviewTitle')}
            </p>
            <p className="text-zinc-300">{t('identities.import.reviewHint')}</p>
            <ul className="space-y-1.5">
                {items.map((item, index) => (
                    <li key={`${item.name}-${index}`} className="space-y-1 rounded-md bg-black/20 px-2 py-1.5">
                        <p className="flex flex-wrap items-baseline gap-x-1.5 text-zinc-100">
                            <span className="font-medium">{item.name}</span>
                            <span className="text-zinc-500" aria-hidden="true">→</span>
                            <span className="sr-only">{t('identities.import.toHost')}</span>
                            <code className="break-all font-mono text-zinc-300">{item.host}</code>
                        </p>
                        <p className="flex flex-wrap items-center gap-1.5 text-zinc-300">
                            <KeyRound className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
                            {t(item.saved ? 'identities.import.savedIdentity' : 'identities.import.newIdentity', { identity: item.identity })}
                            {item.uses.map((credential) => (
                                <Badge key={credential} tone={credential === 'password' ? 'warning' : 'neutral'}>{t(`identities.credentials.${credential}`)}</Badge>
                            ))}
                            {item.agent_forward && <Badge tone="danger">{t('identities.import.forwardsAgent')}</Badge>}
                        </p>
                    </li>
                ))}
            </ul>
            <Checkbox
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                label={t('identities.import.consent')}
                description={t('identities.import.consentHint')}
            />
        </div>
    );
}

// After the import: whether those connections got the credentials.
export function ImportCredentialsResult({ credentials }: { credentials: ConfigImportResult['credentials'] }) {
    const t = useT();
    if (!credentials || credentials.servers.length === 0) return null;
    const count = credentials.servers.length;
    const names = credentials.servers.map((server) => server.name).join(', ');
    return (
        <p className={credentials.linked ? 'text-xs text-zinc-300' : 'text-xs text-amber-200'}>
            {t(`identities.import.${credentials.linked ? 'linked' : 'withheld'}.${count === 1 ? 'one' : 'other'}`, { count })}{' '}
            <span className="text-zinc-400">{names}</span>
        </p>
    );
}
