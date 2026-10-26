import { createSseParser } from '@shared/sse';

// Reads a Server-Sent Events body and hands the JSON `data:` payload of each
// event to `onEvent` (malformed payloads are skipped). Framing is the shared
// WHATWG parser's; resolves when the stream ends, rejects when reading fails
// (e.g. AbortError).
export async function readSseEvents(body: ReadableStream<Uint8Array>, onEvent: (data: unknown) => void): Promise<void> {
    const parser = createSseParser(({ data }) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }
        onEvent(parsed);
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
}
