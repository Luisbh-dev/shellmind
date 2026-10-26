import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLanguage } from '@/i18n';
import type { WorkspaceServer } from '@/workspace/types';
import { NativeLaunch } from './NativeLaunch';

// "Open in external client" (the native launch that stays next to the embedded client).

const WINDOWS: WorkspaceServer = { id: 3, name: 'Win Box', ip: '10.0.0.9', type: 'windows', username: 'admin', domain: 'CORP', port: null, has_password: 1 };

type Reply = { status?: number; body: unknown };
let supportReply: Reply;
let launchReply: Reply;
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const reply = url.endsWith('/api/rdp/native') ? supportReply : launchReply;
    return Response.json(reply.body, { status: reply.status ?? 200 });
});

beforeEach(() => {
    setLanguage('en');
    supportReply = { body: { message: 'success', data: { supported: true, client: 'mstsc', platform: 'win32' } } };
    launchReply = { body: { message: 'success', data: { client: 'mstsc' } } };
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

const launches = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/rdp/launch'));

describe('NativeLaunch', () => {
    it('launches once per click, however often it is clicked', async () => {
        let release: (value: Response) => void = () => undefined;
        fetchMock.mockImplementationOnce(async () => Response.json(supportReply.body));
        fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        render(<NativeLaunch server={WINDOWS} port={3389} />);
        const button = await screen.findByRole('button', { name: 'Open in external client' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(await screen.findByRole('button', { name: /Opening/ })).toHaveAttribute('aria-busy', 'true');
        expect(launches()).toHaveLength(1);
        expect(JSON.parse(String(launches()[0][1]?.body))).toEqual({ serverId: 3 });

        release(Response.json(launchReply.body));
        expect(await screen.findByText(/Remote Desktop Connection \(mstsc\) was opened for 10\.0\.0\.9 in its own window\./)).toBeInTheDocument();
        expect(screen.getByText('Your saved password was handed to it and removed from the system again.')).toBeInTheDocument();
    });

    it('shows the backend’s error', async () => {
        launchReply = { status: 500, body: { error: 'Could not store the Remote Desktop credentials (cmdkey exited with code 87).', code: 'RDP_CREDENTIALS' } };
        render(<NativeLaunch server={WINDOWS} port={3390} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open in external client' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('cmdkey exited with code 87');
    });

    it('offers only the .rdp file when this computer has no client', async () => {
        supportReply = { body: { message: 'success', data: { supported: false, client: null, platform: 'linux' } } };
        render(<NativeLaunch server={WINDOWS} port={3389} />);
        expect(await screen.findByText(/No Remote Desktop app was found on this computer \(linux\)/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open in external client' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Download .rdp file' })).toBeInTheDocument();
    });

    it('starts over for another server', async () => {
        const { rerender } = render(<NativeLaunch server={WINDOWS} port={3389} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open in external client' }));
        expect(await screen.findByText(/was opened for 10\.0\.0\.9/)).toBeInTheDocument();
        rerender(<NativeLaunch server={{ ...WINDOWS, id: 4, ip: '10.0.0.10' }} port={3389} />);
        await waitFor(() => expect(screen.queryByText(/was opened for/)).toBeNull());
    });
});
