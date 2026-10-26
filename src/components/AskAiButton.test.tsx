import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { AskAiButton } from './AskAiButton';

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.getState().setChatOpen(false);
    setLanguage('en');
});

afterEach(() => {
    setLanguage('system');
});

describe('AskAiButton', () => {
    it('opens the chat on a question about what it is next to', () => {
        render(<AskAiButton serverId={4} attachment={{ kind: 'service', name: 'nginx.service' }} />);

        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about nginx.service' }));

        expect(useAppStore.getState().chatOpen).toBe(true);
        expect(useAppStore.getState().chatRequest).toMatchObject({
            serverId: 4,
            kind: 'context',
            attachment: { kind: 'service', name: 'nginx.service' },
            prompt: 'What is wrong with the service nginx.service, and how do I fix it?'
        });
    });

    it('asks the caller’s question, names logs by their source, and the server as a whole plainly', () => {
        const view = render(<AskAiButton serverId={1} attachment={{ kind: 'logs', source: { kind: 'file', path: '/var/log/app.log' } }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about /var/log/app.log' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ prompt: 'What do the logs of /var/log/app.log say is wrong, and how do I fix it?' });
        view.unmount();

        render(<AskAiButton serverId={1} attachment={{ kind: 'logs', source: { kind: 'journal' } }} variant="button" />);
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ prompt: 'What does the system journal say is wrong, and how do I fix it?' });

        render(<AskAiButton serverId={1} attachment={{ kind: 'status' }} prompt="Why is it slow?" label="Diagnose" variant="button" />);
        fireEvent.click(screen.getByRole('button', { name: 'Diagnose' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ attachment: { kind: 'status' }, prompt: 'Why is it slow?' });
    });

    it('says why it is unavailable and does nothing', () => {
        render(
            <>
                <AskAiButton serverId={2} attachment={{ kind: 'triage' }} disabledReason="The AI assistant is off" />
                <AskAiButton serverId={2} attachment={{ kind: 'container', container: 'db' }} variant="button" disabledReason="The AI assistant is off" />
            </>
        );

        for (const button of screen.getAllByRole('button')) {
            expect(button).toHaveAttribute('aria-disabled', 'true');
            expect(button).toHaveAccessibleDescription('The AI assistant is off');
            fireEvent.click(button);
        }
        expect(useAppStore.getState().chatRequest).toBeNull();
        expect(useAppStore.getState().chatOpen).toBe(false);
    });

    it('opens the server first when it is not on screen, on the tab the attachment comes from', () => {
        useAppStore.setState({ activeServerId: 9 });
        render(<AskAiButton serverId={4} attachment={{ kind: 'container', container: 'db' }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about db' }));
        expect(useAppStore.getState().serverTabRequest).toMatchObject({ serverId: 4, tabId: 'operations' });

        useAppStore.setState({ serverTabRequest: null, activeServerId: 4 });
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about db' }));
        expect(useAppStore.getState().serverTabRequest).toBeNull();
        expect(useAppStore.getState().chatRequest).toMatchObject({ serverId: 4, kind: 'context', requestedAt: expect.any(Number) });
    });

    it('sends the log lines selected in its log view instead of the source', () => {
        render(
            <>
                <div data-testid="log"><div>line 1 ok</div><div>line 2 oom-kill</div><div>line 3 ok</div></div>
                <p data-testid="outside">elsewhere</p>
                <AskAiButton serverId={1} attachment={{ kind: 'logs', source: { kind: 'journal', unit: 'app.service' } }} excerptFrom={() => screen.getByTestId('log')} />
            </>
        );
        const button = screen.getByRole('button', { name: 'Ask AI about app.service' });
        expect(button).toHaveAttribute('title', 'Ask AI about app.service. Select some lines first to ask about those lines only.');

        // Nothing selected: the source's latest lines.
        fireEvent.click(button);
        expect(useAppStore.getState().chatRequest).toMatchObject({ attachment: { kind: 'logs', source: { kind: 'journal', unit: 'app.service' } } });
        expect(useAppStore.getState().chatRequest).not.toHaveProperty('attachment.excerpt');

        const select = (node: Node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        };
        select(screen.getByText('line 2 oom-kill'));
        fireEvent.pointerDown(button);
        window.getSelection()!.removeAllRanges();
        fireEvent.click(button);
        expect(useAppStore.getState().chatRequest).toMatchObject({
            attachment: { kind: 'logs', source: { kind: 'journal', unit: 'app.service' }, excerpt: 'line 2 oom-kill' },
            prompt: 'What do these log lines say is wrong, and how do I fix it?'
        });

        // A selection outside the log view does not count.
        select(screen.getByTestId('outside'));
        fireEvent.click(button);
        expect(useAppStore.getState().chatRequest).not.toHaveProperty('attachment.excerpt');
    });

    it('reads a selection across the rows of a log view one line per row', () => {
        const lines = ['10:00:01 app started', '10:00:02 key AKIAABCDEFGHIJKLMNOP loaded', '10:00:03 worker crashed'];
        render(
            <>
                <div data-testid="log" style={{ position: 'relative', height: 54 }}>
                    {lines.map((line, index) => (
                        <div key={line} data-excerpt-line="" style={{ position: 'absolute', top: 0, transform: `translateY(${index * 18}px)` }}>{line}</div>
                    ))}
                </div>
                <AskAiButton serverId={1} attachment={{ kind: 'logs', source: { kind: 'file', path: '/var/log/app.log' } }} excerptFrom={() => screen.getByTestId('log')} />
            </>
        );
        const rows = screen.getByTestId('log').querySelectorAll('[data-excerpt-line]');
        const select = (start: [Node, number], end: [Node, number]) => {
            const range = document.createRange();
            range.setStart(...start);
            range.setEnd(...end);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        };
        const button = screen.getByRole('button', { name: 'Ask AI about /var/log/app.log' });

        // From the middle of the first row to the middle of the last.
        select([rows[0].firstChild!, 9], [rows[2].firstChild!, 15]);
        fireEvent.click(button);
        expect(useAppStore.getState().chatRequest).toMatchObject({
            attachment: { kind: 'logs', excerpt: 'app started\n10:00:02 key AKIAABCDEFGHIJKLMNOP loaded\n10:00:03 worker' }
        });

        // Ending at the very start of a row (a triple click) leaves that row out.
        select([rows[1].firstChild!, 0], [rows[2].firstChild!, 0]);
        fireEvent.click(button);
        expect(useAppStore.getState().chatRequest).toMatchObject({ attachment: { excerpt: '10:00:02 key AKIAABCDEFGHIJKLMNOP loaded' } });
        window.getSelection()!.removeAllRanges();
    });

    it('tells what goes with the question in its tooltip', () => {
        render(<AskAiButton serverId={1} attachment={{ kind: 'status' }} label="Ask AI about this status" hint="The snapshot goes with the question." />);
        expect(screen.getByRole('button', { name: 'Ask AI about this status' })).toHaveAccessibleDescription('Ask AI about this status. The snapshot goes with the question.');
    });

    it('is translated', () => {
        act(() => setLanguage('es'));
        render(<AskAiButton serverId={3} attachment={{ kind: 'container', container: 'web' }} />);

        fireEvent.click(screen.getByRole('button', { name: 'Preguntar a la IA sobre web' }));

        expect(useAppStore.getState().chatRequest).toMatchObject({ prompt: '¿Qué le pasa al contenedor web y cómo lo soluciono?' });
    });
});
