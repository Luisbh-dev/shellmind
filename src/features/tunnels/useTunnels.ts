import { useCallback, useEffect, useState } from 'react';
import type { TunnelView } from '@shared/tunnels';
import { tunnelsApi } from './api';

// Running tunnels are polled often for their live counters, idle ones rarely.
export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 10000;

export const isTunnelRunning = (tunnel: TunnelView) =>
    tunnel.status.state === 'listening' || tunnel.status.state === 'starting';

// The tunnels of a server with their live status, polled while `active`.
export function useTunnels(serverId: number, active: boolean) {
    const [tunnels, setTunnels] = useState<TunnelView[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        let timer: number | undefined;

        const load = async () => {
            let running = false;
            try {
                const data = await tunnelsApi.list(serverId, { signal: controller.signal });
                setTunnels(data);
                setLoadError(null);
                running = data.some(isTunnelRunning);
            } catch (err) {
                if (controller.signal.aborted) return;
                setLoadError(err instanceof Error ? err.message : String(err));
            }
            if (!controller.signal.aborted) timer = window.setTimeout(load, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        };
        void load();

        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [serverId, active, reloadToken]);

    // Fetches now (dropping a poll in flight, which may predate a change).
    const reload = useCallback(() => setReloadToken((token) => token + 1), []);

    const upsert = useCallback((view: TunnelView) => setTunnels((current) => {
        const list = current ?? [];
        return list.some((tunnel) => tunnel.id === view.id)
            ? list.map((tunnel) => (tunnel.id === view.id ? view : tunnel))
            : [...list, view];
    }), []);

    const drop = useCallback((id: number) => setTunnels((current) => current?.filter((tunnel) => tunnel.id !== id) ?? current), []);

    return { tunnels, loadError, reload, upsert, drop };
}
