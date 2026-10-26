// HTTP side of the fleet board (the board itself arrives over the socket feed).
import type { FleetRefreshResult, FleetSettings } from '@shared/fleet';
import { api, unwrapData } from '@/lib/api';

// Starts the checks of `ids` (all monitored servers without one).
export async function requestFleetCheck(ids?: number[]): Promise<FleetRefreshResult> {
    return unwrapData<FleetRefreshResult>(await api.post('/api/fleet/refresh', ids ? { ids } : {}));
}

export async function saveFleetSettings(update: Partial<FleetSettings>): Promise<FleetSettings> {
    return unwrapData<FleetSettings>(await api.put('/api/fleet/settings', update));
}
