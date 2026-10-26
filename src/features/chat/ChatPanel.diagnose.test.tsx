import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatEvidence, ChatRequestBody, ChatStreamEvent } from '@shared/chat';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import ChatPanel from './ChatPanel';

// "Ask AI" in the chat: the attachment's evidence is collected and shown
// before anything is sent, then goes with the question (purpose "diagnose").

const SERVER: WorkspaceServer = { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux', osDetail: 'Ubuntu 22.04' };

const evidence = (overrides: Partial<ChatEvidence> = {}): ChatEvidence => ({
    serverId: 1,
    attachment: { kind: 'service', name: 'nginx.service' },
    collectedAt: Date.now(),
    sections: [
        { id: 'service', title: 'Service status', source: 'systemctl status nginx.service', text: 'Active: failed (Result: exit-code)' },
        { id: 'journal', title: 'Journal of nginx.service (last 200 lines)', source: 'journalctl -u nginx.service -n 200', text: 'bind() to 0.0.0.0:80 failed (98: Address already in use)', truncated: true }
    ],
    access: { platform: 'linux', user: 'deploy', admin: false, sudo: false },
    signature: 'v1.test-signature',
    ...overrides
});

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let historyReply: () => Response;
let evidenceReplies: Array<() => Response | Promise<Response>>;
let chatReply: (body: ChatRequestBody) => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sse(events: ChatStreamEvent[]): Response {
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const answer = (text: string) => () => sse([
    { type: 'model', model: 'MiniMax-M3' },
    { type: 'delta', text },
    { type: 'done', usedModel: 'MiniMax-M3', fullText: text }
]);

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    window.localStorage.clear();
    calls = [];
    historyReply = () => json({ messages: [] });
    evidenceReplies = [];
    chatReply = answer('### Cause\nPort 80 is taken.');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith('/api/config/status')) return json({ features: { minimaxProxy: { route: 'proxy', baseUrl: 'https://ai-proxy.luisbh.com/anthropic/v1' } } });
        if (url.includes('/api/chat/history/') && method === 'GET') return historyReply();
        if (url.includes('/api/chat/history/')) return json({ message: 'success' });
        if (url.endsWith('/api/chat/evidence')) return (evidenceReplies.shift() ?? (() => json({ evidence: evidence() })))();
        if (url.endsWith('/api/chat')) return chatReply(body as ChatRequestBody);
        return json({});
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

function renderChat() {
    return render(
        <ToastProvider>
            <ConfirmProvider>
                <ChatPanel activeServer={SERVER} connectionState="connected" />
            </ConfirmProvider>
        </ToastProvider>
    );
}

const composer = () => screen.getByRole('textbox', { name: 'Message for the AI assistant' });
const chatCalls = () => calls.filter((call) => call.url.endsWith('/api/chat'));
const evidenceCalls = () => calls.filter((call) => call.url.endsWith('/api/chat/evidence'));
const askAboutNginx = () => act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'context', attachment: { kind: 'service', name: 'nginx.service' } }));
const card = () => screen.getByRole('region', { name: 'Attachment: Service nginx.service' });
const pressEnter = () => fireEvent.keyDown(composer(), { key: 'Enter' });

describe('ChatPanel diagnosis', () => {
    it('collects the evidence of an "Ask AI" request, shows exactly what goes, and sends it with the question', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        evidenceReplies.push(async () => {
            await gate;
            return json({ evidence: evidence() });
        });
        renderChat();
        askAboutNginx();

        await waitFor(() => expect(composer()).toHaveValue('What is wrong with the service nginx.service, and how do I fix it?'));
        expect(evidenceCalls()[0].body).toEqual({ serverId: 1, attachment: { kind: 'service', name: 'nginx.service' } });
        expect(within(card()).getByText('Collecting the evidence from web-1…')).toBeInTheDocument();
        // Nothing can be sent before the evidence is in.
        expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeDisabled();
        pressEnter();
        expect(chatCalls()).toHaveLength(0);

        await act(async () => release());
        expect(await within(card()).findByText(/2 parts, .* · sent exactly as shown/)).toBeInTheDocument();
        expect(document.querySelector('div.sr-only[aria-live="polite"]')).toHaveTextContent(/Evidence for Service nginx.service collected/);

        fireEvent.click(within(card()).getByRole('button', { name: 'Review' }));
        expect(within(card()).getByText('Commands run as deploy (not root, no sudo without a password).')).toBeInTheDocument();
        const parts = within(card()).getByRole('list', { name: 'Parts of the evidence' });
        expect(within(parts).getByText('Service status')).toBeInTheDocument();
        expect(within(parts).getByText('shortened')).toBeInTheDocument();
        expect(within(parts).getByText('bind() to 0.0.0.0:80 failed (98: Address already in use)')).toBeInTheDocument();
        expect(within(parts).getByText('journalctl -u nginx.service -n 200')).toBeInTheDocument();

        expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeEnabled();
        pressEnter();
        await waitFor(() => expect(chatCalls()).toHaveLength(1));
        expect(chatCalls()[0].body).toMatchObject({
            purpose: 'diagnose',
            serverId: 1,
            language: 'en',
            message: 'What is wrong with the service nginx.service, and how do I fix it?',
            attachment: { kind: 'service', name: 'nginx.service' },
            evidence: evidence({ collectedAt: (chatCalls()[0].body as ChatRequestBody).evidence!.collectedAt }),
            stream: true
        });
        expect(screen.queryByRole('region', { name: /^Attachment:/ })).toBeNull();
        expect(composer()).toHaveValue('');

        expect(await screen.findByText('Port 80 is taken.')).toBeInTheDocument();
        const sent = screen.getByText('Service nginx.service').closest('details')!;
        expect(sent).toHaveTextContent('Sent with this question');
        // The question and its evidence are saved together.
        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).not.toHaveLength(0), { timeout: 2000 });
        const saved = (calls.filter((call) => call.method === 'PUT').at(-1)!.body as { messages: Array<{ role: string; evidence?: ChatEvidence }> }).messages;
        expect(saved[0]).toMatchObject({ role: 'user', evidence: { signature: 'v1.test-signature' } });
    });

    it('says why the evidence could not be collected, retries it, and sends a plain message once it is removed', async () => {
        evidenceReplies.push(() => json({ error: 'connect ECONNREFUSED 10.0.0.5:22', code: 'SSH_FAILED' }, 502));
        renderChat();
        askAboutNginx();

        expect(await within(card()).findByText(/Couldn't collect the evidence:/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeDisabled();
        fireEvent.click(within(card()).getByRole('button', { name: 'Retry' }));
        expect(await within(card()).findByText(/2 parts/)).toBeInTheDocument();
        expect(evidenceCalls()).toHaveLength(2);

        fireEvent.click(within(card()).getByRole('button', { name: 'Remove attachment' }));
        expect(screen.queryByRole('region', { name: /^Attachment:/ })).toBeNull();
        pressEnter();
        await waitFor(() => expect(chatCalls()).toHaveLength(1));
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'chat', message: 'What is wrong with the service nginx.service, and how do I fix it?' });
        expect((chatCalls()[0].body as ChatRequestBody).evidence).toBeUndefined();
    });

    it('lets the user ask about a server that cannot be reached, with the failed connection as the evidence', async () => {
        evidenceReplies.push(() => json({ evidence: evidence({
            attachment: { kind: 'status' },
            access: undefined,
            sections: [{ id: 'connection', title: 'Connection to the server', source: 'SSH to 10.0.0.5:22', text: 'Error: ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:22' }]
        }) }));
        renderChat();
        act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'context', attachment: { kind: 'status' }, prompt: 'web-1 is unreachable. Why?' }));
        const region = await screen.findByRole('region', { name: 'Attachment: Server status' });
        expect(await within(region).findByText(/1 part, .* · sent exactly as shown/)).toBeInTheDocument();
        fireEvent.click(within(region).getByRole('button', { name: 'Review' }));
        const part = within(region).getByText('Connection to the server').closest('summary')!;
        expect(within(part).getByText('no connection')).toBeInTheDocument();
        expect(within(region).queryByText(/^Commands run as/)).toBeNull();

        pressEnter();
        await waitFor(() => expect(chatCalls()).toHaveLength(1));
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'diagnose', message: 'web-1 is unreachable. Why?', attachment: { kind: 'status' } });
    });

    it('says in the UI language why nothing could be read, with the server\'s own message per part', async () => {
        evidenceReplies.push(() => json({
            error: 'None of the evidence could be read. Last 200 lines of /var/log/nope.log: Could not be read (OPS_COMMAND_FAILED): tail: cannot open',
            code: 'EVIDENCE_UNAVAILABLE',
            details: { sections: [{ id: 'logs', code: 'OPS_COMMAND_FAILED', reason: "tail: cannot open '/var/log/nope.log' for reading: No such file or directory" }] }
        }, 502));
        renderChat();
        act(() => setLanguage('es'));
        act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'context', attachment: { kind: 'logs', source: { kind: 'file', path: '/var/log/nope.log' } } }));
        const region = await screen.findByRole('region', { name: 'Adjunto: Logs de /var/log/nope.log' });
        expect(await within(region).findByText('No se pudieron recopilar las evidencias: no se pudo leer nada del servidor.')).toBeInTheDocument();
        expect(within(region).getByRole('listitem')).toHaveTextContent("Últimas 200 líneas: El comando ha fallado en el servidor. tail: cannot open '/var/log/nope.log' for reading: No such file or directory");
        expect(region).not.toHaveTextContent('None of the evidence');
    });

    it('never lets Auto-Run run the fix of a diagnosis', async () => {
        chatReply = answer('### Fix\n```bash\nsudo systemctl restart nginx\n```');
        renderChat();
        fireEvent.click(screen.getByRole('button', { name: /AUTO/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enable Auto-Run' }));

        askAboutNginx();
        expect(await within(card()).findByText(/2 parts/)).toBeInTheDocument();
        pressEnter();
        expect(await screen.findByText('Auto-Run never runs the fix of a diagnosis: read it, then press Run if you agree.')).toBeInTheDocument();
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        // Run still works, with the usual checks.
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(useAppStore.getState().pendingCommands[1]).toEqual([expect.objectContaining({ command: 'sudo systemctl restart nginx', source: 'ai' })]);
    });

    it('collects the evidence again when the backend no longer accepts it', async () => {
        chatReply = () => json({ error: 'The evidence was collected before ShellMind restarted', code: 'EVIDENCE_EXPIRED' }, 409);
        renderChat();
        askAboutNginx();
        expect(await within(card()).findByText(/2 parts/)).toBeInTheDocument();
        fireEvent.change(composer(), { target: { value: 'why does it fail?' } });
        pressEnter();

        expect(await screen.findByText(/It is being collected again: check it, then send your question again./)).toBeInTheDocument();
        await waitFor(() => expect(evidenceCalls()).toHaveLength(2));
        expect(composer()).toHaveValue('why does it fail?');
        expect(screen.queryByText('Sent with this question')).toBeNull();
        expect(within(card()).getByText(/2 parts/)).toBeInTheDocument();
    });

    it('restores a saved diagnosis with its evidence and regenerates it', async () => {
        const saved = evidence();
        historyReply = () => json({ messages: [{ role: 'user', content: 'Why is nginx down?', evidence: saved }, { role: 'assistant', content: 'Port 80 is taken.' }] });
        renderChat();
        expect(await screen.findByText('Why is nginx down?')).toBeInTheDocument();
        const sent = screen.getByText('Service nginx.service').closest('details')!;
        fireEvent.click(within(sent).getByText('Service nginx.service'));
        expect(within(sent).getByText('Active: failed (Result: exit-code)')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
        await waitFor(() => expect(chatCalls()).toHaveLength(1));
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'diagnose', message: 'Why is nginx down?', evidence: saved, history: [] });
    });

    it('collects again, instead of sending, evidence too old to be accepted', async () => {
        historyReply = () => json({ messages: [{ role: 'user', content: 'Why is nginx down?', evidence: evidence({ collectedAt: Date.now() - 7 * 60 * 60_000 }) }, { role: 'assistant', content: 'Port 80 is taken.' }] });
        renderChat();
        await screen.findByText('Why is nginx down?');
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
        await waitFor(() => expect(evidenceCalls()).toHaveLength(1));
        expect(chatCalls()).toHaveLength(0);
        expect(composer()).toHaveValue('Why is nginx down?');
    });

    it('sends the selected log lines it was given, and drops a request that waited too long', async () => {
        // The backend names the lines by a fingerprint in the evidence; once
        // it is refused, they are collected again from their redacted text.
        const selected = { kind: 'logs', source: { kind: 'journal' }, selection: 'AbCdEfGhIjKlMnOpQr_-12' } as const;
        const reply = () => json({ evidence: evidence({ attachment: selected, sections: [{ id: 'excerpt', title: 'Lines', text: 'oom-kill key [REDACTED]' }] }) });
        evidenceReplies.push(reply, reply);
        chatReply = () => json({ error: 'The evidence was collected before ShellMind restarted', code: 'EVIDENCE_EXPIRED' }, 409);
        renderChat();
        act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'context', attachment: { kind: 'logs', source: { kind: 'journal' }, excerpt: 'oom-kill key AKIAABCDEFGHIJKLMNOP' } }));
        const region = await screen.findByRole('region', { name: 'Attachment: Selected lines of the system journal' });
        expect(composer()).toHaveValue('What do these log lines say is wrong, and how do I fix it?');
        expect(await within(region).findByText(/1 part, .* · sent exactly as shown/)).toBeInTheDocument();

        pressEnter();
        await waitFor(() => expect(evidenceCalls()).toHaveLength(2));
        expect(chatCalls()[0].body).toMatchObject({ purpose: 'diagnose', attachment: selected });
        expect(evidenceCalls()[1].body).toEqual({ serverId: 1, attachment: { kind: 'logs', source: { kind: 'journal' }, excerpt: 'oom-kill key [REDACTED]' } });
        // Only the first request to the backend carried the lines as selected.
        const first = evidenceCalls()[0];
        expect(JSON.stringify(calls.filter((call) => call !== first))).not.toContain('AKIAABCDEFGHIJKLMNOP');
        expect(await screen.findByRole('region', { name: 'Attachment: Selected lines of the system journal' })).toBeInTheDocument();

        act(() => useAppStore.setState({
            chatRequest: { id: 'stale', serverId: 1, kind: 'context', attachment: { kind: 'triage' }, requestedAt: Date.now() - 120_000 }
        }));
        await waitFor(() => expect(useAppStore.getState().chatRequest).toBeNull());
        expect(screen.queryByRole('region', { name: 'Attachment: Triage pack' })).toBeNull();
        expect(evidenceCalls()).toHaveLength(2);
    });

    it('keeps what the user was writing when an "Ask AI" request arrives, but replaces its own question', async () => {
        renderChat();
        await screen.findByRole('textbox', { name: 'Message for the AI assistant' });
        fireEvent.change(composer(), { target: { value: 'my own question about the 502s' } });
        askAboutNginx();
        await waitFor(() => expect(evidenceCalls()).toHaveLength(1));
        expect(composer()).toHaveValue('my own question about the 502s');

        // An empty box, then another "Ask AI": each gets its own question.
        fireEvent.change(composer(), { target: { value: '' } });
        askAboutNginx();
        await waitFor(() => expect(composer()).toHaveValue('What is wrong with the service nginx.service, and how do I fix it?'));
        act(() => useAppStore.getState().requestChat({ serverId: 1, kind: 'context', attachment: { kind: 'triage' } }));
        await waitFor(() => expect(composer()).toHaveValue('Check this server for problems: failed services, recent errors, disk, memory and the busiest processes.'));
    });

    it('is translated', async () => {
        renderChat();
        act(() => setLanguage('es'));
        askAboutNginx();
        const attachment = await screen.findByRole('region', { name: 'Adjunto: Servicio nginx.service' });
        expect(await within(attachment).findByText(/2 partes, .* · se envía tal cual se muestra/)).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Mensaje para el asistente de IA' })).toHaveValue('¿Qué le pasa al servicio nginx.service y cómo lo soluciono?');
        fireEvent.click(within(attachment).getByRole('button', { name: 'Revisar' }));
        expect(within(attachment).getByText('Los comandos se ejecutan como deploy (sin ser root ni sudo sin contraseña).')).toBeInTheDocument();
        expect(within(attachment).getByText('Journal del servicio (últimas 200 líneas)')).toBeInTheDocument();
    });
});
