import type { Response } from "express";

// Server-Sent Events writer for one response. `onClientClose` runs when the
// client closes the connection before end() was called.
export function createSseStream(res: Response, onClientClose: () => void) {
    let sseStarted = false;
    let sseFinished = false;

    const start = () => {
        if (sseStarted) return;
        sseStarted = true;
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });
        res.flushHeaders?.();
        res.on("close", () => {
            if (!sseFinished) onClientClose();
        });
    };

    const send = (payload: object) => {
        if (!sseStarted || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const end = () => {
        sseFinished = true;
        if (sseStarted && !res.writableEnded) res.end();
    };

    return { start, send, end, started: () => sseStarted };
}
