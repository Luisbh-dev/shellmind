// Incremental Server-Sent Events parser (WHATWG event-stream format), the one
// SSE framer of the app: the AI provider stream on the backend, and the
// /api/chat and multi-exec streams in the UI.
// Lines may end in CRLF, LF or CR, also when a chunk splits a CRLF pair.

export type SseEvent = {
    // "message" when the event had no `event:` field.
    event: string;
    data: string;
    id?: string;
};

export type SseParser = {
    push(chunk: string): void;
    // Flushes a final event the stream did not terminate with a blank line
    // (a truncated stream); call once the body has ended.
    end(): void;
};

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
    let buffer = "";
    // The previous chunk ended in CR: a leading LF of the next one belongs to it.
    let skipLeadingLf = false;
    let eventName = "";
    let dataLines: string[] = [];
    let lastId: string | undefined;
    let hasData = false;

    const dispatch = () => {
        if (hasData) {
            onEvent({ event: eventName || "message", data: dataLines.join("\n"), ...(lastId !== undefined ? { id: lastId } : {}) });
        }
        eventName = "";
        dataLines = [];
        hasData = false;
    };

    const processLine = (line: string) => {
        if (line === "") {
            dispatch();
            return;
        }
        if (line.startsWith(":")) return;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "data") {
            dataLines.push(value);
            hasData = true;
        } else if (field === "event") {
            eventName = value;
        } else if (field === "id" && !value.includes("\0")) {
            lastId = value;
        }
    };

    return {
        push(chunk: string) {
            if (!chunk) return;
            if (skipLeadingLf && chunk.startsWith("\n")) chunk = chunk.slice(1);
            skipLeadingLf = false;
            buffer += chunk;

            let start = 0;
            for (let i = 0; i < buffer.length; i++) {
                const ch = buffer[i];
                if (ch !== "\n" && ch !== "\r") continue;
                processLine(buffer.slice(start, i));
                if (ch === "\r") {
                    if (i + 1 < buffer.length) {
                        if (buffer[i + 1] === "\n") i++;
                    } else {
                        skipLeadingLf = true;
                    }
                }
                start = i + 1;
            }
            buffer = buffer.slice(start);
        },
        end() {
            if (buffer) processLine(buffer);
            buffer = "";
            dispatch();
        }
    };
}
