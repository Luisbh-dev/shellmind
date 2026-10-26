import { useEffect, useState } from 'react';
import { AUDIT_RETENTION_DAYS, type AuditRetentionDays, type AuditSettings } from '@shared/types';
import { Field, Select, useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { fetchAuditSettings, saveAuditRetention } from './api';

// How long the audit log keeps entries. A shorter period deletes the older
// entries at once, so it asks first; the newest maxEntries stay in any case.

// 0 (no age limit) counts as the longest.
const span = (days: AuditRetentionDays) => (days === 0 ? Number.POSITIVE_INFINITY : days);

function retentionLabel(days: AuditRetentionDays, t: TranslateFn): string {
    if (days === 0) return t('audit.retention.forever');
    if (days === 365) return t('audit.retention.year');
    return t('audit.retention.days', { count: days });
}

export function RetentionControl({ onPruned }: { onPruned: () => void }) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const [settings, setSettings] = useState<AuditSettings | null>(null);
    const [failed, setFailed] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        fetchAuditSettings(controller.signal).then(setSettings, () => {
            if (!controller.signal.aborted) setFailed(true);
        });
        return () => controller.abort();
    }, []);

    // Without the setting (an older backend) there is nothing to change.
    if (failed) return null;

    const max = settings ? new Intl.NumberFormat(language).format(settings.maxEntries) : '';
    const options = AUDIT_RETENTION_DAYS.map((days) => ({
        value: String(days),
        label: retentionLabel(days, t),
        ...(days === 0 ? { description: t('audit.retention.foreverHint', { max }) } : {})
    }));

    const change = async (value: string) => {
        const days = Number(value) as AuditRetentionDays;
        if (!settings || days === settings.retentionDays) return;
        const period = retentionLabel(days, t);
        if (span(days) < span(settings.retentionDays)) {
            const ok = await confirm({
                title: t('audit.retention.confirmTitle'),
                message: t('audit.retention.confirmMessage', { period, max }),
                confirmLabel: t('audit.retention.confirm', { period }),
                tone: 'danger'
            });
            if (!ok) return;
        }
        setSaving(true);
        try {
            const { settings: saved, pruned } = await saveAuditRetention(days);
            setSettings(saved);
            toast.success(
                saved.retentionDays === 0 ? t('audit.retention.savedForever') : t('audit.retention.saved', { period: retentionLabel(saved.retentionDays, t) }),
                pruned > 0 ? (pruned === 1 ? t('audit.retention.prunedOne') : t('audit.retention.pruned', { count: new Intl.NumberFormat(language).format(pruned) })) : undefined
            );
            if (pruned > 0) onPruned();
        } catch (err) {
            toast.error(t('audit.retention.failed'), err instanceof Error ? err.message : undefined);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Field label={t('audit.retention.label')} className="flex items-center gap-2 space-y-0">
            <Select
                value={settings ? String(settings.retentionDays) : ''}
                onChange={(value) => void change(value)}
                options={options}
                placeholder={t('audit.loading')}
                disabled={!settings || saving}
                className="h-8 w-36 text-xs"
            />
        </Field>
    );
}
