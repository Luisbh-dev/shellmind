import { useEffect, useRef } from 'react';
import { CopyPlus, FileWarning, Replace, SkipForward } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/i18n';

const LISTED = 5;

export type OverwriteChoice = 'replace' | 'skip' | 'keepBoth';

export type OverwriteDialogProps = {
    path: string;
    clashes: Array<{ name: string; isDir: boolean }>;
    onChoose: (choice: OverwriteChoice) => void;
    onCancel: () => void;
};

// Uploads whose names are already taken in the target folder: replace them,
// skip them, or upload them under a free name ("name (1).ext").
export function OverwriteDialog({ path, clashes, onChoose, onCancel }: OverwriteDialogProps) {
    const t = useT();
    const title = clashes.length === 1
        ? t('files.overwriteDialog.titleOne', { name: clashes[0].name })
        : t('files.overwriteDialog.title', { count: clashes.length });
    const folderClash = clashes.some((clash) => clash.isDir);
    const keepBothRef = useRef<HTMLButtonElement>(null);

    // The choice that loses nothing is the default.
    useEffect(() => { keepBothRef.current?.focus(); }, []);

    return (
        <Modal
            open
            onClose={onCancel}
            title={title}
            description={t('files.overwriteDialog.description', { path })}
            icon={<FileWarning className="h-4 w-4" />}
            widthClass="max-w-lg"
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
                    <Button variant="subtle" size="sm" onClick={() => onChoose('skip')}>
                        <SkipForward className="h-3.5 w-3.5" aria-hidden />{t('files.overwriteDialog.skip')}
                    </Button>
                    <Button ref={keepBothRef} variant="subtle" size="sm" onClick={() => onChoose('keepBoth')}>
                        <CopyPlus className="h-3.5 w-3.5" aria-hidden />{t('files.overwriteDialog.keepBoth')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => onChoose('replace')}>
                        <Replace className="h-3.5 w-3.5" aria-hidden />{t('files.overwriteDialog.replace')}
                    </Button>
                </>
            }
        >
            <ul className="max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2 font-mono text-xs text-zinc-300 scrollbar-thin">
                {clashes.slice(0, LISTED).map((clash) => <li key={clash.name} className="truncate">{clash.isDir ? `${clash.name}/` : clash.name}</li>)}
                {clashes.length > LISTED && <li className="text-zinc-500">{t('files.overwriteDialog.more', { count: clashes.length - LISTED })}</li>}
            </ul>
            {folderClash && <p className="mt-3 text-xs text-amber-300/90">{t('files.overwriteDialog.folderClash')}</p>}
        </Modal>
    );
}
