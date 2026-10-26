import { useId, useState } from 'react';
import { Cable, Plus } from 'lucide-react';
import { tunnelConnectAddress, TUNNEL_PRESETS, type TunnelInput, type TunnelPresetId, type TunnelView } from '@shared/tunnels';
import { Button, Spinner, useConfirm, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import type { WorkspaceServer } from '@/workspace/types';
import { HostKeyCard } from '@/features/knownHosts/public';
import { tunnelsApi } from './api';
import { apiErrorCode } from '@/lib/api';
import { describeLastError, problemFromError, problemText, tunnelName } from './format';
import { TunnelCard, type TunnelAction } from './TunnelCard';
import { TunnelForm } from './TunnelForm';
import { isTunnelRunning, useTunnels } from './useTunnels';

type Editor = { mode: 'create'; preset: TunnelPresetId } | { mode: 'edit'; tunnel: TunnelView };

export interface TunnelsPanelProps {
    server: WorkspaceServer;
    isActive: boolean;
}

// The Tunnels tab: SSH local port forwards of one server, with live status,
// and the host key pinned for it.
export default function TunnelsPanel({ server, isActive }: TunnelsPanelProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const headingId = useId();
    const { tunnels, loadError, reload, upsert, drop } = useTunnels(server.id, isActive);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [pending, setPending] = useState<ReadonlyMap<number, TunnelAction>>(new Map());
    const [hostKeyToken, setHostKeyToken] = useState(0);

    const setPendingFor = (id: number, action: TunnelAction | null) => setPending((current) => {
        const next = new Map(current);
        if (action) next.set(id, action);
        else next.delete(id);
        return next;
    });

    // A start in flight counts as running (the card shows it as starting).
    const asShown = (tunnel: TunnelView): TunnelView => (pending.get(tunnel.id) === 'start' && !isTunnelRunning(tunnel)
        ? { ...tunnel, status: { ...tunnel.status, state: 'starting' } }
        : tunnel);

    const start = async (tunnel: TunnelView) => {
        setPendingFor(tunnel.id, 'start');
        try {
            const view = await tunnelsApi.start(tunnel.id);
            upsert(view);
            if (view.status.state === 'listening') toast.success(t('tunnels.toast.started', { address: tunnelConnectAddress(view) }));
        } catch (err) {
            const problem = problemFromError(t, err, tunnel);
            // Cancelled by a stop or an edit the user made meanwhile: not a failure.
            if (apiErrorCode(err) === 'TUNNEL_START_CANCELLED') toast.info(t('tunnels.toast.startCancelled', { name: tunnelName(tunnel) }), problem.text);
            else toast.error(t('tunnels.toast.startFailed', { name: tunnelName(tunnel) }), problemText(problem));
        } finally {
            setPendingFor(tunnel.id, null);
            // A first connection pins the host key.
            setHostKeyToken((token) => token + 1);
            reload();
        }
    };

    const stop = async (tunnel: TunnelView) => {
        setPendingFor(tunnel.id, 'stop');
        try {
            upsert(await tunnelsApi.stop(tunnel.id));
            toast.info(t('tunnels.toast.stopped', { name: tunnelName(tunnel) }));
        } catch (err) {
            toast.error(t('tunnels.toast.stopFailed', { name: tunnelName(tunnel) }), problemFromError(t, err, tunnel).text);
        } finally {
            setPendingFor(tunnel.id, null);
            reload();
        }
    };

    const remove = async (tunnel: TunnelView) => {
        const name = tunnelName(tunnel);
        const ok = await confirm({
            title: t('tunnels.confirmDelete.title'),
            message: t('tunnels.confirmDelete.message', { name }),
            confirmLabel: t('tunnels.confirmDelete.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        try {
            await tunnelsApi.remove(tunnel.id);
            drop(tunnel.id);
            toast.success(t('tunnels.toast.deleted', { name }));
        } catch (err) {
            toast.error(t('tunnels.toast.deleteFailed'), problemFromError(t, err, tunnel).text);
        } finally {
            reload();
        }
    };

    const copy = async (address: string) => {
        try {
            await copyText(address);
            toast.success(t('tunnels.toast.copied', { address }));
        } catch {
            toast.error(t('tunnels.toast.copyFailed'));
        }
    };

    const save = async (input: TunnelInput, startAfter: boolean) => {
        const editing = editor?.mode === 'edit' ? editor.tunnel : undefined;
        // A running tunnel restarts with the new settings (see the PUT route).
        const wasRunning = editing ? isTunnelRunning(asShown(tunnels?.find((item) => item.id === editing.id) ?? editing)) : false;
        const saved = editing ? await tunnelsApi.update(editing.id, input) : await tunnelsApi.create(server.id, input);
        upsert(saved);
        setEditor(null);
        const name = tunnelName(saved);
        if (wasRunning && saved.status.state === 'error' && saved.status.lastError) {
            toast.error(t('tunnels.toast.restartFailed', { name }), problemText(describeLastError(t, saved.status.lastError, saved)));
        } else {
            toast.success(t(editing ? 'tunnels.toast.saved' : 'tunnels.toast.created', { name }));
        }
        if (startAfter) await start(saved);
        else reload();
    };

    const presetLabel = (id: TunnelPresetId) =>
        id === 'custom' ? t('tunnels.presets.custom') : TUNNEL_PRESETS.find((preset) => preset.id === id)?.name ?? id;

    return (
        <div className="absolute inset-0 overflow-y-auto bg-ink-900">
            <div className="mx-auto max-w-5xl space-y-6 p-6 md:p-8">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                    <div className="flex items-start gap-3">
                        <span aria-hidden="true" className="mt-0.5 rounded-xl border border-white/5 bg-white/[0.03] p-2.5 text-brand-400">
                            <Cable className="h-5 w-5" />
                        </span>
                        <div>
                            <h2 id={headingId} className="text-lg font-semibold text-zinc-100">{t('tunnels.title')}</h2>
                            <p className="mt-0.5 max-w-2xl text-sm text-zinc-400">{t('tunnels.subtitle', { server: server.name })}</p>
                        </div>
                    </div>
                    <Button variant="primary" size="sm" className="shrink-0 self-start whitespace-nowrap md:self-auto" onClick={() => setEditor({ mode: 'create', preset: 'custom' })}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t('tunnels.add')}
                    </Button>
                </div>

                <section aria-label={t('tunnels.presets.title')} className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{t('tunnels.presets.title')}</span>
                    {TUNNEL_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            title={t('tunnels.presets.label', { service: preset.name })}
                            onClick={() => setEditor({ mode: 'create', preset: preset.id })}
                            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-brand-500/40 hover:bg-brand-500/10 hover:text-brand-200 focus-ring"
                        >
                            {presetLabel(preset.id)}{' '}
                            <span className="ml-1 font-mono text-[10px] text-zinc-500">{preset.remotePort}</span>
                        </button>
                    ))}
                </section>

                <section aria-labelledby={headingId}>
                    {!tunnels && !loadError && (
                        <p className="flex items-center gap-2 text-sm text-zinc-400">
                            <Spinner className="h-4 w-4" />
                            {t('tunnels.loading')}
                        </p>
                    )}
                    {loadError && (
                        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                            <span>{t('tunnels.loadFailed')} {loadError}</span>
                            <Button size="sm" variant="ghost" onClick={reload}>{t('tunnels.retry')}</Button>
                        </div>
                    )}
                    {tunnels && tunnels.length === 0 && (
                        <div className="rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
                            <Cable className="mx-auto h-8 w-8 text-zinc-600" aria-hidden="true" />
                            <h3 className="mt-3 text-sm font-semibold text-zinc-200">{t('tunnels.empty.title')}</h3>
                            <p className="mx-auto mt-1 max-w-md text-xs text-zinc-400">{t('tunnels.empty.hint')}</p>
                        </div>
                    )}
                    {tunnels && tunnels.length > 0 && (
                        <ul aria-label={t('tunnels.listLabel', { server: server.name })} className="space-y-2.5">
                            {tunnels.map((tunnel) => (
                                <TunnelCard
                                    key={tunnel.id}
                                    tunnel={tunnel}
                                    pending={pending.get(tunnel.id)}
                                    onToggle={(target, run) => void (run ? start(target) : stop(target))}
                                    onEdit={(target) => setEditor({ mode: 'edit', tunnel: asShown(target) })}
                                    onDelete={(target) => void remove(target)}
                                    onCopy={(address) => void copy(address)}
                                    onOpen={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
                                />
                            ))}
                        </ul>
                    )}
                </section>

                <HostKeyCard server={server} isActive={isActive} refreshToken={hostKeyToken} />
            </div>

            {editor && (
                <TunnelForm
                    key={editor.mode === 'edit' ? `edit-${editor.tunnel.id}` : `create-${editor.preset}`}
                    serverName={server.name}
                    tunnel={editor.mode === 'edit' ? editor.tunnel : undefined}
                    initialPreset={editor.mode === 'create' ? editor.preset : undefined}
                    onClose={() => setEditor(null)}
                    onSubmit={save}
                />
            )}
        </div>
    );
}
