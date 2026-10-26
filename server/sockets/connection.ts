import { createLogger } from "../logger";
import { registerDownloadHandlers } from "./download";
import { registerFileHandlers } from "./files";
import { registerLogHandlers } from "./logs";
import { registerRdpNativeHandlers } from "./rdpNative";
import { createSession, disposeSession, type ShellMindSocket } from "./session";
import { registerTerminalHandlers } from "./terminal";
import { registerUploadHandlers } from "./upload";
// --- W7-S1 fleet board ---
import { registerFleetHandlers } from "../fleet/socket";
// --- W7-S6 embedded RDP ---
import { registerRdpHandlers } from "../rdp/socket";

// One socket = one session: every handler module shares the same mutable
// session object, which is released when the socket disconnects.
export function handleConnection(socket: ShellMindSocket): void {
    // One socket per terminal tab, file panel and log viewer: debug only (slice V4b).
    createLogger("socket").debug(`Client connected ${socket.id}`);

    const session = createSession(socket);

    registerTerminalHandlers(session);
    registerFileHandlers(session);
    registerUploadHandlers(session);
    registerDownloadHandlers(session);
    registerRdpNativeHandlers(session);
    registerLogHandlers(session);
    // --- W7-S1 fleet board ---
    registerFleetHandlers(session);
    // --- W7-S6 embedded RDP ---
    registerRdpHandlers(session);

    socket.on("disconnect", () => {
        disposeSession(session);
    });
}
