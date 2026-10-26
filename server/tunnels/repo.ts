import { TUNNEL_SERVER_TYPES } from "../../shared/tunnels";
import type { Tunnel } from "../../shared/types";
import { dbAll, dbGet, dbRun, type DbClient } from "../db/sqlite";

// Saved SSH tunnels (local port forwards), one row per forward. Rows go away
// with their server (serversRepo.remove).

type TunnelRow = Omit<Tunnel, "auto_start"> & { auto_start: number };

// The fields a tunnel is saved with (validated by parseTunnelInput()).
export type TunnelFields = Pick<Tunnel, "name" | "local_host" | "local_port" | "remote_host" | "remote_port" | "auto_start">;

const toTunnel = (row: TunnelRow): Tunnel => ({ ...row, auto_start: row.auto_start === 1 });

async function insertTunnel(client: Pick<DbClient, "run">, serverId: number, fields: TunnelFields): Promise<number> {
    const { lastID } = await client.run(
        `INSERT INTO tunnels (server_id, name, local_host, local_port, remote_host, remote_port, auto_start, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [serverId, fields.name, fields.local_host, fields.local_port, fields.remote_host, fields.remote_port, fields.auto_start ? 1 : 0, Date.now()]
    );
    return lastID;
}

export const tunnelsRepo = {
    async get(id: number): Promise<Tunnel | null> {
        const row = await dbGet<TunnelRow>("SELECT * FROM tunnels WHERE id = ?", [id]);
        return row ? toTunnel(row) : null;
    },

    async listByServer(serverId: number): Promise<Tunnel[]> {
        const rows = await dbAll<TunnelRow>("SELECT * FROM tunnels WHERE server_id = ? ORDER BY id", [serverId]);
        return rows.map(toTunnel);
    },

    // Rows of a server that is no longer an SSH server are kept but not started.
    async listAutoStart(): Promise<Tunnel[]> {
        const types = TUNNEL_SERVER_TYPES.map(() => "?").join(", ");
        const rows = await dbAll<TunnelRow>(
            `SELECT tunnels.* FROM tunnels JOIN servers ON servers.id = tunnels.server_id
             WHERE tunnels.auto_start = 1 AND servers.type IN (${types}) ORDER BY tunnels.id`,
            [...TUNNEL_SERVER_TYPES]
        );
        return rows.map(toTunnel);
    },

    async create(serverId: number, fields: TunnelFields): Promise<Tunnel> {
        const lastID = await insertTunnel({ run: dbRun }, serverId, fields);
        const created = await tunnelsRepo.get(lastID);
        if (!created) throw new Error(`Tunnel #${lastID} vanished after it was created`);
        return created;
    },

    // Inside a caller's transaction (the configuration import); returns the id.
    createIn(tx: DbClient, serverId: number, fields: TunnelFields): Promise<number> {
        return insertTunnel(tx, serverId, fields);
    },

    async update(id: number, fields: TunnelFields): Promise<Tunnel | null> {
        const { changes } = await dbRun(
            `UPDATE tunnels SET name = ?, local_host = ?, local_port = ?, remote_host = ?, remote_port = ?, auto_start = ?
             WHERE id = ?`,
            [fields.name, fields.local_host, fields.local_port, fields.remote_host, fields.remote_port, fields.auto_start ? 1 : 0, id]
        );
        return changes > 0 ? tunnelsRepo.get(id) : null;
    },

    async remove(id: number): Promise<boolean> {
        const { changes } = await dbRun("DELETE FROM tunnels WHERE id = ?", [id]);
        return changes > 0;
    }
};
