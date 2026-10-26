import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TunnelInput, TunnelView } from '@shared/tunnels';
import { setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import { TunnelForm } from './TunnelForm';

const EXPOSED: TunnelView = {
    id: 3,
    server_id: 1,
    name: 'Web',
    local_host: '0.0.0.0',
    local_port: 18080,
    remote_host: '10.0.0.9',
    remote_port: 80,
    auto_start: true,
    created_at: 0,
    status: { state: 'listening', activeConnections: 0, totalConnections: 0, bytesOut: 0, bytesIn: 0, startedAt: 1, lastError: null },
};

function renderForm(props: Partial<React.ComponentProps<typeof TunnelForm>> = {}) {
    const onSubmit = vi.fn<(input: TunnelInput, start: boolean) => Promise<void>>(async () => undefined);
    const onClose = vi.fn();
    render(<TunnelForm serverName="db-1" onClose={onClose} onSubmit={onSubmit} {...props} />);
    return { onSubmit: props.onSubmit ? vi.mocked(props.onSubmit) : onSubmit, onClose };
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

describe('TunnelForm', () => {
    it('fills the ports from the chosen service and focuses the name', () => {
        renderForm();
        expect(screen.getByLabelText('Name')).toHaveFocus();
        expect(screen.getByRole('button', { name: /^Custom/ })).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(screen.getByRole('button', { name: /^PostgreSQL/ }));
        expect(screen.getByRole('button', { name: /^PostgreSQL/ })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByLabelText('Remote port')).toHaveValue('5432');
        expect(screen.getByLabelText('Local port')).toHaveValue('15432');
        expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'PostgreSQL');

        // Typing a known port selects its service.
        change('Remote port', '6443');
        expect(screen.getByRole('button', { name: /^Kubernetes API/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('validates ports and addresses before submitting', () => {
        const { onSubmit } = renderForm();
        change('Local port', '70000');
        change('Remote port', '');
        change('Listen address', 'my-laptop');
        change('Remote host', 'bad host');
        fireEvent.click(screen.getByRole('button', { name: 'Save and start' }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Local port')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('Local port')).toHaveAccessibleDescription(/Enter a port between 1 and 65535/);
        expect(screen.getByLabelText('Remote port')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('Listen address')).toHaveAccessibleDescription(/Enter an IP address of this computer/);
        expect(screen.getByLabelText('Remote host')).toHaveAccessibleDescription(/Enter a host name or an IP address/);
    });

    it('rejects an IPv4 address with an octet above 255 without asking about the network', () => {
        const { onSubmit } = renderForm({ initialPreset: 'http' });
        change('Listen address', '999.1.1.1');
        expect(screen.queryByText('Reachable from your network')).toBeNull();
        expect(screen.queryByText(/Programs on this computer connect to/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Listen address')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('Listen address')).toHaveAccessibleDescription(/Enter an IP address of this computer/);
    });

    it('explains a backend validation error in Spanish', async () => {
        setLanguage('es');
        const onSubmit = vi.fn(async () => {
            throw new ApiError(400, 'remote_host must be a host name or an IP address', {
                error: 'remote_host must be a host name or an IP address', code: 'INVALID_TUNNEL', details: { field: 'remote_host' },
            });
        });
        renderForm({ onSubmit, initialPreset: 'postgresql' });
        fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('No se pudo guardar el túnel.');
        expect(alert).toHaveTextContent('El valor de «Host remoto» no es válido.');
        expect(alert).not.toHaveTextContent('must be');
    });

    it('requires a confirmation to listen on an address other machines can reach', async () => {
        const { onSubmit } = renderForm({ initialPreset: 'http' });
        change('Listen address', '0.0.0.0');
        expect(screen.getByText('Reachable from your network')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('Tick the confirmation above to listen on 0.0.0.0, or use 127.0.0.1.');

        fireEvent.click(screen.getByRole('checkbox', { name: 'I understand: listen on 0.0.0.0' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Start automatically when ShellMind starts' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
            name: null,
            local_host: '0.0.0.0',
            local_port: 10080,
            remote_host: '127.0.0.1',
            remote_port: 80,
            auto_start: true,
            confirm_public_bind: true,
        }, false));
    });

    it('edits a running exposed tunnel without asking again, and saves without a separate start', async () => {
        const { onSubmit } = renderForm({ tunnel: EXPOSED });
        expect(screen.getByText('Edit tunnel')).toBeInTheDocument();
        expect(screen.getByText('This tunnel is running: it restarts with the new settings.')).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /I understand/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Save and start' })).toBeNull();

        change('Name', 'Intranet');
        fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Intranet', local_host: '0.0.0.0', remote_host: '10.0.0.9' }), false));
        expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('confirm_public_bind');
    });

    it('keeps the form open and explains a failed save', async () => {
        const onSubmit = vi.fn(async () => {
            throw new ApiError(409, 'Port 15432 is taken', { error: 'Port 15432 is taken', code: 'PORT_IN_USE' });
        });
        renderForm({ onSubmit, initialPreset: 'postgresql' });
        fireEvent.click(screen.getByRole('button', { name: 'Save and start' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not save the tunnel.');
        expect(alert).toHaveTextContent('Local port 15432 is already in use.');
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ local_port: 15432, remote_port: 5432 }), true);
        expect(screen.getByRole('button', { name: 'Save and start' })).toBeEnabled();
    });

    it('closes on cancel', () => {
        const { onClose } = renderForm();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
    });
});
