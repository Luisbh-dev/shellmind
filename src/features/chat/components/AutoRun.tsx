import { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2, Square, Zap } from 'lucide-react';
import type { DangerReason } from '@shared/commandSafety';
import { Button, Modal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { AUTO_RUN_MAX_STEPS, type AutoRunState } from '../lib/autoRun';

export const DANGER_KEYS: Record<DangerReason, string> = {
    'recursive-delete': 'chat.danger.recursiveDelete',
    disk: 'chat.danger.disk',
    power: 'chat.danger.power',
    'fork-bomb': 'chat.danger.forkBomb',
    permissions: 'chat.danger.permissions',
    database: 'chat.danger.database',
    firewall: 'chat.danger.firewall',
    'cloud-delete': 'chat.danger.cloudDelete',
    'container-data': 'chat.danger.containerData',
    processes: 'chat.danger.processes',
    scheduler: 'chat.danger.scheduler',
    'remote-code': 'chat.danger.remoteCode',
    backdoor: 'chat.danger.backdoor',
    overwrite: 'chat.danger.overwrite'
};

export function AutoRunToggle({ enabled, onToggle, disabled }: { enabled: boolean; onToggle: () => void; disabled?: boolean }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={disabled}
            aria-pressed={enabled}
            title={enabled ? t('chat.autoRun.turnOff') : t('chat.autoRun.turnOn')}
            className={cn(
                'flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors focus-ring disabled:opacity-40',
                enabled ? 'border-amber-500/50 bg-amber-500/20 text-amber-300' : 'border-white/5 text-zinc-400 hover:bg-white/5 hover:text-zinc-300'
            )}
        >
            <Zap aria-hidden="true" className="h-3 w-3 fill-current" />
            <span>{enabled ? t('chat.autoRun.on') : t('chat.autoRun.off')}</span>
            <span className="sr-only">{t('chat.autoRun.label')}</span>
        </button>
    );
}

export function AutoRunConfirmDialog({ open, serverName, onConfirm, onCancel }: { open: boolean; serverName: string; onConfirm: () => void; onCancel: () => void }) {
    const t = useT();
    const cancelRef = useRef<HTMLButtonElement>(null);
    // The safe choice has the focus.
    useEffect(() => {
        if (open) cancelRef.current?.focus();
    }, [open]);
    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={t('chat.autoRun.confirmTitle')}
            icon={<Zap className="h-4 w-4" />}
            widthClass="max-w-sm"
            footer={
                <>
                    <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
                    <Button size="sm" onClick={onConfirm} className="border-transparent bg-amber-500 font-semibold text-fixed-black hover:bg-amber-600 hover:border-transparent">
                        {t('chat.autoRun.enable')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3 text-sm leading-relaxed text-zinc-300">
                {/* The machine is what the user confirms: never truncated. */}
                <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-400">{t('chat.autoRun.confirmTarget')}</p>
                    <p className="break-words font-semibold text-zinc-100 [overflow-wrap:anywhere]">{serverName}</p>
                </div>
                <p>{t('chat.autoRun.confirmBody', { steps: AUTO_RUN_MAX_STEPS })}</p>
                <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-100">{t('chat.autoRun.confirmWarning')}</p>
            </div>
        </Modal>
    );
}

// The chain in flight: its step, a Stop button, and the approval card of a
// destructive command.
export function AutoRunStatus({ state, serverName, onStop, onApprove, onSkip }: {
    state: AutoRunState;
    serverName: string;
    onStop: () => void;
    onApprove: () => void;
    onSkip: () => void;
}) {
    const t = useT();
    const skipRef = useRef<HTMLButtonElement>(null);
    const awaiting = state.phase === 'awaiting-approval' && state.pending !== null;
    useEffect(() => {
        if (awaiting) skipRef.current?.focus();
    }, [awaiting]);

    if (state.phase === 'idle') return null;

    if (awaiting && state.pending) {
        return (
            <div role="alertdialog" aria-labelledby="autorun-danger-title" className="mx-3 mb-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[12px] text-rose-100 animate-slide-up">
                <div id="autorun-danger-title" className="mb-1 flex items-center gap-1.5 font-semibold">
                    <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" /> {t('chat.autoRun.dangerTitle')}
                </div>
                <p className="mb-2 text-rose-200/90">{t('chat.autoRun.dangerBody', { reason: t(DANGER_KEYS[state.pending.danger.reason]), name: serverName })}</p>
                <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[11px] text-zinc-100 scrollbar-thin [overflow-wrap:anywhere]">
                    {state.pending.command}
                </pre>
                <div className="flex justify-end gap-2">
                    <Button ref={skipRef} variant="ghost" size="sm" onClick={onSkip}>{t('chat.autoRun.skip')}</Button>
                    <Button variant="danger" size="sm" onClick={onApprove}>{t('chat.autoRun.approve')}</Button>
                </div>
            </div>
        );
    }

    return (
        <div role="status" className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1">
                {t(state.phase === 'running' ? 'chat.autoRun.running' : 'chat.autoRun.analyzing', { step: state.step, max: AUTO_RUN_MAX_STEPS })}
            </span>
            <button type="button" onClick={onStop} aria-label={t('chat.autoRun.stopLabel')} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-amber-100 hover:bg-amber-500/20 focus-ring">
                <Square aria-hidden="true" className="h-3 w-3 fill-current" /> {t('chat.autoRun.stop')}
            </button>
        </div>
    );
}
