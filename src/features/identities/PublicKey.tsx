import { Copy } from 'lucide-react';
import { IconButton, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';

// An OpenSSH public key line (what goes into authorized_keys), selectable
// and with a copy button.
export function PublicKey({ value, name, className }: { value: string; name: string; className?: string }) {
    const t = useT();
    const toast = useToast();
    const copy = async () => {
        try {
            await copyText(value);
            toast.success(t('identities.publicKey.copied'));
        } catch {
            toast.error(t('identities.publicKey.copyFailed'));
        }
    };
    return (
        <div className={cn('flex items-start gap-2 rounded-lg border border-white/[0.06] bg-black/20 py-1.5 pl-3 pr-1.5', className)}>
            <code className="min-w-0 flex-1 select-all break-all py-0.5 font-mono text-[11px] leading-relaxed text-zinc-300">{value}</code>
            <IconButton size="sm" variant="ghost" label={t('identities.publicKey.copyLabel', { name })} onClick={() => void copy()}>
                <Copy className="h-3.5 w-3.5" />
            </IconButton>
        </div>
    );
}
