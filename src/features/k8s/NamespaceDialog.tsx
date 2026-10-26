import { useState, type FormEvent } from 'react';
import { Layers } from 'lucide-react';
import { isValidK8sNamespace } from '@shared/k8s';
import { Button, Field, Input, Modal } from '@/components/ui';
import { useT } from '@/i18n';

// A namespace typed by hand: for users who may work in a namespace but not
// list the cluster's namespaces (RBAC), so the picker cannot offer it.

export function NamespaceDialog({ initial, onCancel, onChoose }: { initial: string; onCancel: () => void; onChoose: (namespace: string) => void }) {
    const t = useT();
    const [value, setValue] = useState(initial);
    const name = value.trim();
    const error = name && !isValidK8sNamespace(name) ? t('k8s.otherNamespace.invalid') : undefined;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name && !error) onChoose(name);
    };

    return (
        <Modal
            open
            onClose={onCancel}
            icon={<Layers className="h-4 w-4" />}
            title={t('k8s.otherNamespace.title')}
            description={t('k8s.otherNamespace.description')}
            footer={
                <>
                    <Button variant="ghost" onClick={onCancel}>{t('k8s.otherNamespace.cancel')}</Button>
                    <Button type="submit" form="k8s-namespace-form" variant="primary" disabled={!name || Boolean(error)}>{t('k8s.otherNamespace.confirm')}</Button>
                </>
            }
        >
            <form id="k8s-namespace-form" onSubmit={submit}>
                <Field label={t('k8s.namespace')} error={error}>
                    <Input value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} autoComplete="off" className="font-mono" data-autofocus />
                </Field>
            </form>
        </Modal>
    );
}
