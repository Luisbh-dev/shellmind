import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { serverAddress } from './describe';
import { ServerPicker } from './ServerPicker';

const DEPLOY: IdentitySummary = {
    id: 1, name: 'deploy', username: 'deployer', private_key_path: null, use_agent: 0, public_key: null, fingerprint: null, key_type: null,
    has_password: 1, has_private_key: 0, has_passphrase: 0, server_count: 1, created_at: 1, updated_at: 1,
};

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-a', ip: '127.0.0.1', port: 2201, type: 'linux', username: 'alice', tags: ['web'], group_name: 'Lab' },
    { id: 2, name: 'web-b', ip: '127.0.0.1', port: 2202, type: 'linux', username: 'alice', tags: ['web', 'eu'], group_name: 'Lab' },
    { id: 3, name: 'db', ip: 'db.example', type: 'linux', identity_id: 1, tags: ['db'] },
    { id: 4, name: 'win', ip: '::1', type: 'windows', ssh_port: 2222, port: 3390, username: 'Administrator' },
];

function Harness() {
    const [selected, setSelected] = useState<Set<number>>(new Set());
    return <ServerPicker servers={SERVERS} selected={selected} onChange={setSelected} identities={[DEPLOY]} label="Servers" />;
}

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

describe('serverAddress', () => {
    it('shows the user it signs in as and the SSH port when it is not 22', () => {
        expect(serverAddress(SERVERS[0])).toBe('alice@127.0.0.1:2201');
        expect(serverAddress(SERVERS[2], DEPLOY.username)).toBe('deployer@db.example');
        expect(serverAddress(SERVERS[2])).toBe('db.example');
        // Windows keeps the SSH port in ssh_port (port is RDP's).
        expect(serverAddress(SERVERS[3])).toBe('Administrator@[::1]:2222');
        expect(serverAddress({ ...SERVERS[0], port: 22 })).toBe('alice@127.0.0.1');
    });
});

describe('ServerPicker', () => {
    it('tells servers on one host apart and filters by search, group and tag', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const list = screen.getByRole('list', { name: 'Servers' });
        expect(within(list).getByText('alice@127.0.0.1:2201')).toBeInTheDocument();
        expect(within(list).getByText('alice@127.0.0.1:2202')).toBeInTheDocument();
        expect(within(list).getByText('deployer@db.example')).toBeInTheDocument();

        await user.click(screen.getByRole('combobox', { name: 'Tag' }));
        await user.click(screen.getByRole('option', { name: '#eu' }));
        expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
        expect(within(list).getByText('web-b')).toBeInTheDocument();

        await user.click(screen.getByRole('combobox', { name: 'Tag' }));
        await user.click(screen.getByRole('option', { name: 'All tags' }));
        await user.click(screen.getByRole('combobox', { name: 'Group' }));
        await user.click(screen.getByRole('option', { name: 'No group' }));
        expect(within(list).getAllByRole('checkbox')).toHaveLength(2);

        await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'win admin');
        expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
        expect(within(list).getByText('win')).toBeInTheDocument();
    });
});
