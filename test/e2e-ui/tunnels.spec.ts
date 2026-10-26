import net from 'node:net';
import { expect, openApp, test, uid } from './support/test';
import { openServer, openWorkspaceTab } from './support/ui';

// SSH tunnels (local port forwarding) with real traffic: a port on this
// machine reaches the web server that listens only on the host's loopback.

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

async function fetchThrough(port: number): Promise<string> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hello.txt`, { signal: AbortSignal.timeout(5000) });
        return await res.text();
    } catch {
        return 'unreachable';
    }
}

test('a tunnel forwards a local port to a service behind the server, until it is stopped', async ({ page, state, addServer }) => {
    const id = uid();
    const server = await addServer('alpha', { name: `Tunnels ${id}` });
    const port = await freePort();
    await openApp(page, state);
    await openServer(page, server.name);
    const tunnels = await openWorkspaceTab(page, 'Tunnels');
    await expect(tunnels.getByRole('heading', { name: 'No tunnels yet' })).toBeVisible();

    await tunnels.getByRole('button', { name: 'New tunnel' }).click();
    const form = page.getByRole('dialog', { name: 'New tunnel' });
    await form.getByRole('textbox', { name: 'Name' }).fill(`web ${id}`);
    await expect(form.getByRole('textbox', { name: 'Listen address' })).toHaveValue('127.0.0.1');
    await form.getByRole('textbox', { name: 'Local port' }).fill(String(port));
    await expect(form.getByRole('textbox', { name: 'Remote host' })).toHaveValue('127.0.0.1');
    await form.getByRole('textbox', { name: 'Remote port' }).fill('8080');
    await form.getByRole('button', { name: 'Save and start' }).click();
    await expect(form).toBeHidden();

    const list = tunnels.getByRole('region', { name: 'SSH tunnels' });
    const card = list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `web ${id}` }) });
    await expect(card).toContainText(`From 127.0.0.1:${port} on this computer to 127.0.0.1:8080 as seen from the server`);
    const toggle = card.getByRole('switch', { name: `Run tunnel web ${id}` });
    await expect(toggle).toBeChecked();
    await expect(card).toContainText('Listening');
    // A real round trip: HTTP over the forwarded port, answered by the host.
    await expect.poll(() => fetchThrough(port), { timeout: 30_000 })
        .toBe(`tunnel says hello from ${state.hosts.alpha.container.replace('shellmind-test-e2eui-', '')}\n`);
    await expect(card).toContainText(/\d+ open · [1-9]\d* total/);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => fetchThrough(port), { timeout: 15_000 }).toBe('unreachable');

    // Started again, then deleted.
    await toggle.click();
    await expect(card).toContainText('Listening');
    await expect.poll(() => fetchThrough(port), { timeout: 30_000 }).toContain('tunnel says hello');
    await card.getByRole('button', { name: `Delete tunnel web ${id}` }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: /^Delete/ }).click();
    await expect(tunnels.getByRole('heading', { name: 'No tunnels yet' })).toBeVisible();
    await expect.poll(() => fetchThrough(port), { timeout: 15_000 }).toBe('unreachable');
});
