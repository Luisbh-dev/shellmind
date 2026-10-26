import { useState, type FormEvent } from 'react';
import { Scaling } from 'lucide-react';
import { K8S_MAX_REPLICAS, type K8sWorkload } from '@shared/k8s';
import { Button, Field, Input, Modal } from '@/components/ui';
import { useT } from '@/i18n';

// The number of replicas of a deployment or statefulset (`kubectl scale`).
// Scaling to 0 stops every pod of it: the dialog says so before it runs.

type ScaleDialogProps = {
    workload: K8sWorkload;
    busy: boolean;
    onCancel: () => void;
    onScale: (replicas: number) => void;
};

export function ScaleDialog({ workload, busy, onCancel, onScale }: ScaleDialogProps) {
    const t = useT();
    const [value, setValue] = useState(String(workload.desired ?? 1));
    const replicas = /^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    const valid = Number.isInteger(replicas) && replicas >= 0 && replicas <= K8S_MAX_REPLICAS;
    const unchanged = valid && replicas === workload.desired;
    const error = value.trim() && !valid ? t('k8s.scale.invalid', { max: K8S_MAX_REPLICAS }) : undefined;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (valid && !unchanged && !busy) onScale(replicas);
    };

    return (
        <Modal
            open
            onClose={onCancel}
            dismissible={!busy}
            icon={<Scaling className="h-4 w-4" />}
            title={t('k8s.scale.title', { kind: t(`k8s.kinds.${workload.kind}`), name: workload.name })}
            description={t('k8s.scale.description', { current: workload.desired ?? 0, ready: workload.ready ?? 0 })}
            footer={
                <>
                    <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('k8s.scale.cancel')}</Button>
                    <Button type="submit" form="k8s-scale-form" variant={valid && replicas === 0 ? 'danger' : 'primary'} disabled={!valid || unchanged} loading={busy}>
                        {t('k8s.scale.confirm')}
                    </Button>
                </>
            }
        >
            <form id="k8s-scale-form" onSubmit={submit} className="space-y-3">
                <Field label={t('k8s.scale.replicas')} error={error} hint={t('k8s.scale.hint', { max: K8S_MAX_REPLICAS })}>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={K8S_MAX_REPLICAS}
                        step={1}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        data-autofocus
                    />
                </Field>
                {valid && replicas === 0 && <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100" role="status">{t('k8s.scale.zero')}</p>}
            </form>
        </Modal>
    );
}
