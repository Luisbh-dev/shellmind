import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ServerSummary } from '@shared/types';
import App from '@/App';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { GlobalActionProps } from './types';

// How App wires global actions: a fake descriptor stands in for the feature
// slices' real ones.
vi.mock('./registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./registry')>();
    const { Network } = await import('lucide-react');
    const DemoSurface = ({ onClose, server }: GlobalActionProps) => (
        <div role="dialog" aria-label="demo surface">
            demo:{server?.name ?? 'none'}
            <button onClick={onClose}>close demo</button>
        </div>
    );
    return {
        ...actual,
        actionRegistry: actual.createActionRegistry([{
            id: 'demo',
            order: 10,
            labelKey: 'app.tabs.status',
            icon: Network,
            shortcut: 'Ctrl+J',
            placement: 'header',
            Component: DemoSurface,
        }]),
    };
});

vi.mock('@/features/terminal/TerminalPanel', () => ({ default: () => null }));
vi.mock('@/features/files/FileExplorer', () => ({ default: () => null }));
vi.mock('@/features/status/StatusDashboard', () => ({ default: () => null }));
vi.mock('@/features/chat/ChatPanel', () => ({ default: () => null }));

const SERVERS: ServerSummary[] = [{ id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' }];

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.stubGlobal('fetch', vi.fn(async () =>
        new Response(JSON.stringify({ message: 'success', data: SERVERS }), { headers: { 'Content-Type': 'application/json' } })
    ));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('global actions in the app shell', () => {
    it('renders header actions and mounts the open one until it closes itself', async () => {
        render(<App />);
        const button = within(screen.getByRole('banner')).getByRole('button', { name: 'Status' });
        expect(button).toHaveAttribute('title', 'Status (Ctrl+J)');

        fireEvent.click(button);
        expect(screen.getByRole('dialog', { name: 'demo surface' })).toHaveTextContent('demo:none');
        expect(useAppStore.getState().activeActionId).toBe('demo');

        fireEvent.click(screen.getByRole('button', { name: 'close demo' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(useAppStore.getState().activeActionId).toBeNull();
    });

    it('opens an action from its keyboard shortcut with the active server', async () => {
        render(<App />);
        fireEvent.click(await within(screen.getByRole('navigation', { name: 'Saved connections' })).findByText('web-1'));

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, cancelable: true }));
        });

        expect(screen.getByRole('dialog', { name: 'demo surface' })).toHaveTextContent('demo:web-1');
    });

    it('closes an action whose id is no longer registered', () => {
        useAppStore.getState().openAction('removed');
        render(<App />);
        expect(useAppStore.getState().activeActionId).toBeNull();
    });
});
