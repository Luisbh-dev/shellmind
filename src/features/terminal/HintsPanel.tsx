import { useEffect, useRef } from 'react';
import { useT } from '@/i18n';
import type { WorkspaceServer } from '@/workspace/types';
import { hintGroupsFor, type Hint } from './hints';
import { Popover } from './Popover';

function targetLabel(server: WorkspaceServer, t: ReturnType<typeof useT>): string {
    if (server.type === 'local') return t('terminal.hints.targets.cli', { tool: server.cli_preset ?? '' });
    if (server.type === 'windows' || server.type === 'ftp') return t(`terminal.hints.targets.${server.type}`);
    return t('terminal.hints.targets.linux');
}

// Common commands for the kind of server. Ready-made ones run on click; ones
// that need a name (a service, a folder) are typed at the prompt to finish.
export function HintsPanel({ server, onPick, onClose }: { server: WorkspaceServer; onPick: (hint: Hint) => void; onClose: () => void }) {
    const t = useT();
    const listRef = useRef<HTMLDivElement>(null);
    const groups = hintGroupsFor(server);

    useEffect(() => {
        const frame = requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <Popover
            title={t('terminal.hints.title')}
            subtitle={t('terminal.hints.subtitle', { target: targetLabel(server, t) })}
            closeLabel={t('terminal.hints.close')}
            onClose={onClose}
            width="w-[21rem]"
        >
            <div ref={listRef} className="max-h-[340px] space-y-3 overflow-y-auto p-2 scrollbar-thin">
                {groups.map((group) => (
                    <section key={group.id} aria-labelledby={`hint-group-${group.id}`} className="space-y-1.5">
                        <div className="px-1">
                            <h3 id={`hint-group-${group.id}`} className="text-[11px] font-semibold text-zinc-200">{t(`terminal.hints.groups.${group.id}.title`)}</h3>
                            <p className="text-[11px] text-zinc-400">{t(`terminal.hints.groups.${group.id}.subtitle`)}</p>
                        </div>
                        <ul className="space-y-1">
                            {group.items.map((hint) => (
                                <li key={hint.id}>
                                    <button
                                        type="button"
                                        onClick={() => onPick(hint)}
                                        title={hint.editable ? t('terminal.hints.editHelp') : undefined}
                                        className="group w-full rounded-lg border border-white/5 bg-black/30 px-3 py-2 text-left transition-colors hover:border-white/10 hover:bg-white/5 focus-ring"
                                    >
                                        <span className="flex items-start justify-between gap-3">
                                            <span className="min-w-0">
                                                <span className="block text-xs font-medium text-zinc-200 group-hover:text-brand-300">{t(`terminal.hints.items.${hint.id}.title`)}</span>
                                                <span className="mt-0.5 block text-[11px] text-zinc-400">{t(`terminal.hints.items.${hint.id}.description`)}</span>
                                            </span>
                                            <span className={hint.editable
                                                ? 'shrink-0 rounded border border-amber-500/30 px-1.5 text-[11px] text-amber-300'
                                                : 'shrink-0 font-mono text-[11px] text-zinc-400'}
                                            >
                                                {t(hint.editable ? 'terminal.hints.edit' : 'terminal.hints.run')}
                                            </span>
                                        </span>
                                        <span className="mt-1 block truncate font-mono text-[11px] text-zinc-400">{hint.cmd}{hint.editable ? '…' : ''}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </Popover>
    );
}
