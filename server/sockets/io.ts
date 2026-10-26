import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../../shared/protocol";
import { getSessionToken, tokensMatch } from "../auth";
import { requestRejection } from "../http/network";
import { corsOriginCheck } from "../http/origin";
import { createLogger } from "../logger";
import { handleConnection } from "./connection";

const log = createLogger("socket");

export type ShellMindIo = Server<ClientToServerEvents, ServerToClientEvents>;

export type SocketServerOptions = {
    // Defaults to the process-wide session token.
    authToken?: string;
};

export function createSocketServer(httpServer: HttpServer, options: SocketServerOptions = {}): ShellMindIo {
    const authToken = options.authToken ?? getSessionToken().value;

    const io: ShellMindIo = new Server(httpServer, {
        cors: {
            origin: corsOriginCheck,
            methods: ["GET", "POST"]
        },
        // CORS only gates the polling handshake and raw WebSocket upgrades are
        // not subject to it, so Host and Origin are verified here: a refused
        // handshake gets a 403 (polling) or a closed upgrade.
        allowRequest: (req, callback) => {
            const rejection = requestRejection(req.headers);
            if (rejection) log.warn(`${rejection}: socket handshake refused (host ${JSON.stringify(req.headers.host ?? "")}, origin ${JSON.stringify(req.headers.origin ?? "")})`);
            callback(rejection, !rejection);
        },
        transports: ['websocket', 'polling'], // Allow both but prefer websocket
        maxHttpBufferSize: 1e7 // 10 MB — uploads are chunked, but keep headroom per message
    });

    // The session token travels in the handshake's auth payload.
    io.use((socket, next) => {
        if (tokensMatch(authToken, socket.handshake.auth?.token)) return next();
        log.warn(`Socket ${socket.id} refused: missing or invalid token`);
        next(new Error("unauthorized"));
    });

    io.on("connection", handleConnection);

    return io;
}
