import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ChatMessage } from '../types';
import { useProgressiveMessages } from './useProgressiveMessages';

const message = (id: number, size: number): ChatMessage => ({ id: String(id), role: 'assistant', kind: 'chat', content: 'x'.repeat(size) });

// Each message costs this much to render the first time (its Markdown).
const RENDER_MS_PER_MESSAGE = 6;

function spin(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) { /* busy: a slow render */ }
}

let idle: IdleRequestCallback[];

function SlowConversation({ messages }: { messages: ChatMessage[] }) {
    const { visible } = useProgressiveMessages(messages);
    return (
        <ul>
            {visible.map((item) => <SlowMessage key={item.id} id={item.id} />)}
        </ul>
    );
}

function SlowMessage({ id }: { id: string }) {
    // Mounting is what costs: a message renders its Markdown once.
    return <li ref={(el) => { if (el && !el.dataset.done) { el.dataset.done = '1'; spin(RENDER_MS_PER_MESSAGE); } }}>{id}</li>;
}

beforeEach(() => {
    idle = [];
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => idle.push(callback));
    vi.stubGlobal('cancelIdleCallback', () => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const count = () => document.querySelectorAll('li').length;

describe('useProgressiveMessages', () => {
    it('renders a small first batch, then sizes each idle batch to what this machine renders in time', () => {
        const messages = Array.from({ length: 40 }, (_, i) => message(i, 1000));
        render(<SlowConversation messages={messages} />);
        // The newest messages only, in the task that selected the server.
        expect(count()).toBeLessThanOrEqual(2);
        expect(document.querySelector('li')?.textContent).toBe('38');

        const batches: number[] = [];
        while (idle.length && batches.length < 100) {
            const callback = idle.shift();
            const shown = count();
            act(() => callback?.({ didTimeout: false, timeRemaining: () => 50 }));
            batches.push(count() - shown);
        }
        expect(count()).toBe(40);
        expect(document.querySelector('li')?.textContent).toBe('0');
        // Rendering one message takes 6 ms here: after the first timed batch,
        // no batch takes more than about three of them (~16 ms).
        expect(Math.max(...batches.slice(1))).toBeLessThanOrEqual(3);
    });
});
