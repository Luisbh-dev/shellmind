import type { RdpOptions } from "../../shared/rdp";
import { rdpAskPasswordKey as askPasswordKey, settingsRepo } from "../db/settingsRepo";

// Options of a saved Windows server's embedded client, kept by the backend
// (settings table) so they hold whatever device or browser connects; they
// go with the server (serversRepo.remove).

export const rdpOptions = {
    async get(serverId: number): Promise<RdpOptions> {
        return { askPassword: (await settingsRepo.get(askPasswordKey(serverId))) === "1" };
    },

    async set(serverId: number, options: RdpOptions): Promise<RdpOptions> {
        if (options.askPassword) await settingsRepo.set(askPasswordKey(serverId), "1");
        else await settingsRepo.delete(askPasswordKey(serverId));
        return { askPassword: options.askPassword };
    }
};
