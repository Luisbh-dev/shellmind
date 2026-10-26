import { loadConnectionTarget } from "../connections/target";
import { AppError } from "../errors";
import { launchNativeRdp } from "../local/rdp";
import { createLogger } from "../logger";
import type { SocketSession } from "./session";

const log = createLogger("rdp");

// Opens the native Remote Desktop client for a saved Windows server (the UI
// uses POST /api/rdp/launch; this event does the same over a socket).
export function registerRdpNativeHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("launch-rdp-native", async (payload) => {
        try {
            const target = await loadConnectionTarget(payload?.serverId, "rdp");
            await launchNativeRdp(target);
            socket.emit("rdp-native-launched");
        } catch (err) {
            // Expected failures carry a safe message; anything else could echo
            // a command line, so only a generic one leaves the backend.
            if (err instanceof AppError) {
                socket.emit("rdp-error", err.message);
            } else {
                log.error("Native RDP launch failed unexpectedly");
                socket.emit("rdp-error", "Could not open the Remote Desktop client.");
            }
        }
    });
}
