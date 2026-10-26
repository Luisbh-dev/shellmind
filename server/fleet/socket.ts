import { DEFAULT_FLEET_SETTINGS, type FleetBoard } from "../../shared/fleet";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import type { SocketSession } from "../sockets/session";
import { fleetMonitor, type FleetMonitor } from "./monitor";

const log = createLogger("fleet");

// "fleet-subscribe" answers with the whole board and then pushes what
// changes as "fleet-health" events, until "fleet-unsubscribe" or the socket
// goes away. Subscribing first and then reading the board through the same
// call leaves no gap in which a change could be missed.
export function registerFleetHandlers(session: SocketSession, monitor: FleetMonitor = fleetMonitor): void {
    const { socket } = session;
    let unsubscribe: (() => void) | null = null;
    const stop = () => {
        unsubscribe?.();
        unsubscribe = null;
    };

    socket.on("fleet-subscribe", (ack) => {
        unsubscribe ??= monitor.onChange((event) => socket.emit("fleet-health", event));
        monitor.board().then(
            (board) => {
                if (typeof ack === "function") ack(board);
            },
            (err: unknown) => {
                log.warn(`Could not read the fleet board: ${errorMessage(err)}`);
                const empty: FleetBoard = { settings: DEFAULT_FLEET_SETTINGS, snapshots: [] };
                if (typeof ack === "function") ack(empty);
            }
        );
    });
    socket.on("fleet-unsubscribe", stop);
    socket.on("disconnect", stop);
}
