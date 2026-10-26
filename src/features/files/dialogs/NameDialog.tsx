import { useEffect, useId, useRef, useState } from 'react';
import { FolderPlus, Pencil } from 'lucide-react';
import { Button, Field, Input, Modal } from '@/components/ui';
import type { FileProtocol } from '@shared/files';
import { useT } from '@/i18n';
import { nameProblem } from '../listing';

export type NameDialogProps = {
    mode: 'create' | 'rename';
    // The current name (rename) or "" (create).
    initial: string;
    parentPath: string;
    // Names already in the folder.
    taken: ReadonlySet<string>;
    // Decides how long a name may be (S3 limits the whole key instead).
    protocol?: FileProtocol;
    // Resolves true when done (the dialog closes), false to stay open.
    onSubmit: (name: string) => Promise<boolean>;
    onClose: () => void;
};

export function NameDialog({ mode, initial, parentPath, taken, protocol = 'sftp', onSubmit, onClose }: NameDialogProps) {
    const t = useT();
    const [value, setValue] = useState(initial);
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const errorId = useId();

    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        // Select the name without its extension, like file managers do.
        const dot = mode === 'rename' ? initial.lastIndexOf('.') : -1;
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, [initial, mode]);

    const name = value.trim();
    const others = mode === 'rename' ? new Set([...taken].filter((item) => item !== initial)) : taken;
    const problem = nameProblem(name, others, protocol, parentPath);
    const unchanged = mode === 'rename' && name === initial;
    const showProblem = touched && problem !== null;

    const submit = async () => {
        setTouched(true);
        if (busy || problem || unchanged) {
            if (unchanged) onClose();
            return;
        }
        setBusy(true);
        const done = await onSubmit(name).catch(() => false);
        setBusy(false);
        if (done) onClose();
    };

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!busy}
            title={mode === 'create' ? t('files.nameDialog.newFolderTitle') : t('files.nameDialog.renameTitle')}
            description={mode === 'create'
                ? t('files.nameDialog.newFolderDescription', { path: parentPath })
                : t('files.nameDialog.renameDescription', { name: initial })}
            icon={mode === 'create' ? <FolderPlus className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" loading={busy} disabled={!!problem && touched} onClick={() => void submit()}>
                        {mode === 'create' ? t('files.nameDialog.create') : t('files.nameDialog.rename')}
                    </Button>
                </>
            }
        >
            <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
                <Field label={t('files.nameDialog.label')}>
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(event) => { setValue(event.target.value); setTouched(true); }}
                        aria-label={t('files.nameDialog.label')}
                        aria-invalid={showProblem}
                        aria-describedby={showProblem ? errorId : undefined}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </Field>
                {showProblem && (
                    <p id={errorId} role="alert" className="mt-2 text-xs text-rose-300">
                        {t(`files.nameDialog.problems.${problem}`)}
                    </p>
                )}
            </form>
        </Modal>
    );
}
