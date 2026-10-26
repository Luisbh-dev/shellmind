import { describe, expect, it } from "vitest";
import { MAX_JUMP_HOPS, normalizeHost, routeHops, savedJumpRoute, type RouteServer } from "./hostRoutes";

const servers = (rows: RouteServer[]) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (id: number) => byId.get(id);
};

describe("saved jump routes", () => {
    it("lists the jump hosts from the first hop, with their SSH ports", () => {
        const lookup = servers([
            { id: 1, ip: " bastion.example.com\u00A0", type: "linux", port: null, jump_server_id: null },
            { id: 2, ip: "10.0.0.9", type: "windows", port: 3389, ssh_port: 2200, jump_server_id: 1 },
        ]);
        expect(savedJumpRoute({ id: 1, jump_server_id: null }, lookup)).toBe("");
        expect(savedJumpRoute({ id: 3, jump_server_id: 2 }, lookup)).toBe("bastion.example.com:22>10.0.0.9:2200");
        expect(routeHops("bastion.example.com:22>10.0.0.9:2200")).toEqual(["bastion.example.com:22", "10.0.0.9:2200"]);
        expect(routeHops("")).toEqual([]);
        expect(routeHops(undefined)).toEqual([]);
    });

    it("has no route for a chain that cannot connect", () => {
        const loop = servers([
            { id: 1, ip: "a", type: "linux", jump_server_id: 2 },
            { id: 2, ip: "b", type: "linux", jump_server_id: 1 },
        ]);
        expect(savedJumpRoute({ id: 1, jump_server_id: 2 }, loop)).toBeNull();
        expect(savedJumpRoute({ id: 9, jump_server_id: 7 }, loop)).toBeNull();
        const ftpJump = servers([{ id: 1, ip: "files", type: "ftp", jump_server_id: null }]);
        expect(savedJumpRoute({ id: 2, jump_server_id: 1 }, ftpJump)).toBeNull();

        const chain: RouteServer[] = Array.from({ length: MAX_JUMP_HOPS + 1 }, (_, index) => ({
            id: index + 1, ip: `10.0.0.${index + 1}`, type: "linux", jump_server_id: index === 0 ? null : index
        }));
        expect(savedJumpRoute({ id: 100, jump_server_id: MAX_JUMP_HOPS }, servers(chain))).toMatch(/^10\.0\.0\.1:22>/);
        expect(savedJumpRoute({ id: 100, jump_server_id: MAX_JUMP_HOPS + 1 }, servers(chain))).toBeNull();
    });

    it("drops every kind of space from an address", () => {
        expect(normalizeHost(" 10.0.0.5\u00A0\t")).toBe("10.0.0.5");
    });
});
