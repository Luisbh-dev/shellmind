import fs from 'node:fs';
import net from 'node:net';
import { selfSignedCertificate, startFakeRdpServer, type FakeRdpServer } from '../helpers/rdpServer';
import { expect, openApp, test, uid } from './support/test';
import { openServer, openWorkspaceTab, runFromPalette } from './support/ui';

// The Remote Desktop tab without a real Windows sign-in: its idle state, the
// password prompt, an unreachable server, the certificate pinned on first
// use against a fake RDP server (TLS) and a changed certificate, and the .rdp
// file. "Open in external client" is never pressed: it would start the
// system's Remote Desktop app. Then the Kubernetes tab of a server without
// kubectl.

function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

let fake: FakeRdpServer | undefined;
test.afterEach(async () => {
    await fake?.close();
    fake = undefined;
});

test('the Remote Desktop tab asks for the password and reports an unreachable server', async ({ page, state, addServer }, testInfo) => {
    const port = await closedPort();
    // Its SSH port is closed too: nothing ever signs in to this machine.
    const server = await addServer('alpha', { name: `Windows ${uid()}`, type: 'windows', port, ssh_port: port, username: 'e2e-user', password: undefined });
    await openApp(page, state);
    await openServer(page, server.name);

    // A Windows server opens on its desktop.
    const rdp = page.getByRole('tabpanel', { name: 'RDP', exact: true });
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'RDP' })).toHaveAttribute('aria-selected', 'true');
    await expect(rdp.getByRole('heading', { name: 'Remote Desktop', level: 2 })).toBeVisible();
    await expect(rdp).toContainText(`127.0.0.1:${port} as e2e-user`);
    await expect(rdp).toContainText('No password is saved for this connection: you type it when you connect.');
    await expect(rdp.getByRole('region', { name: 'Server certificate' })).toContainText('Not seen yet.');

    // No saved password: it is asked for, and required.
    await rdp.getByRole('button', { name: 'Connect', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: `Sign in to ${server.name}` });
    await expect(prompt.getByRole('textbox', { name: 'User name' })).toHaveValue('e2e-user');
    await prompt.getByRole('button', { name: 'Connect' }).click();
    await expect(prompt).toContainText('Enter the password.');
    await prompt.getByRole('textbox', { name: 'Password' }).fill('not-a-real-password');
    await prompt.getByRole('button', { name: 'Connect' }).click();
    await expect(prompt).toBeHidden();

    // Connecting, then the reason it could not.
    await expect(rdp.getByRole('status')).toContainText(server.name);
    const failure = rdp.getByRole('alert');
    await expect(failure).toContainText('Could not connect', { timeout: 60_000 });
    await expect(failure).toContainText(`127.0.0.1:${port} could not be reached (connection refused).`);
    await expect(rdp.getByRole('button', { name: 'Reconnect' })).toBeVisible();

    // The .rdp file for another client.
    const download = page.waitForEvent('download');
    await rdp.getByRole('button', { name: 'Download .rdp file' }).click();
    const file = testInfo.outputPath('connection.rdp');
    await (await download).saveAs(file);
    // mstsc writes .rdp files as UTF-16 with a byte order mark.
    const bytes = fs.readFileSync(file);
    const contents = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    expect(contents).toContain(`full address:s:127.0.0.1:${port}`);
    expect(contents).toContain('username:s:e2e-user');
    expect(contents).not.toContain('not-a-real-password');
});

test('the certificate of an RDP server is pinned on first use and a new one needs approval', async ({ page, state, addServer }) => {
    fake = await startFakeRdpServer({ certificate: selfSignedCertificate('e2e-rdp-one') });
    const closed = await closedPort();
    const server = await addServer('alpha', { name: `Windows TLS ${uid()}`, type: 'windows', port: fake.port, ssh_port: closed, username: 'e2e-user', password: 'not-a-real-password' });
    await openApp(page, state);
    await openServer(page, server.name);
    const rdp = page.getByRole('tabpanel', { name: 'RDP', exact: true });
    await expect(rdp).toContainText('Signs in with the saved password.');
    await expect(rdp.getByRole('checkbox', { name: 'Ask for the password each time' })).not.toBeChecked();

    // The TLS handshake pins the certificate; the fake server speaks no RDP
    // after it, so the sign-in never ends: cancel it.
    const signIn = async () => {
        const connecting = rdp.getByRole('status').filter({ hasText: 'Signing in as e2e-user' });
        await expect(connecting).toBeVisible({ timeout: 60_000 });
        await connecting.getByRole('button', { name: 'Cancel' }).click();
    };
    await rdp.getByRole('button', { name: 'Connect', exact: true }).click();
    await signIn();
    expect(fake.log).toContain('tls');
    const certificate = rdp.getByRole('region', { name: 'Server certificate' });
    await expect(certificate).toContainText('Trusted since');
    await expect(certificate).toContainText('e2e-rdp-one');

    // A different certificate is refused until the user trusts it.
    fake.setCertificate(selfSignedCertificate('e2e-rdp-two'));
    await rdp.getByRole('button', { name: /^(Connect|Reconnect)$/ }).first().click();
    await expect(page.getByText('The server presented a different certificate')).toBeVisible({ timeout: 60_000 });
    const trust = page.getByRole('button', { name: 'Trust the new certificate and connect' });
    await expect(trust).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(certificate).toContainText('e2e-rdp-one');
    await rdp.getByRole('button', { name: /^(Connect|Reconnect)$/ }).first().click();
    await expect(trust).toBeVisible({ timeout: 60_000 });
    await trust.click();
    await signIn();
    await expect(certificate).toContainText('e2e-rdp-two');
});

test('the Kubernetes tab of a server without kubectl says what is missing', async ({ page, state, addServer }) => {
    const server = await addServer('alpha', { name: `No kubectl ${uid()}` });
    await openApp(page, state);
    await openServer(page, server.name);
    // Not offered until kubectl is found; the palette looks for it on demand.
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'Kubernetes' })).toHaveCount(0);
    await runFromPalette(page, 'look for kubectl', /^Kubernetes: look for kubectl on this server/);
    const k8s = await openWorkspaceTab(page, 'Kubernetes');
    await expect(k8s).toContainText('kubectl is not installed on this server', { timeout: 60_000 });
    await expect(k8s).toContainText('Install kubectl and set up a kubeconfig, then check again.');
    await expect(k8s.getByRole('link', { name: /How to install kubectl/ }).or(k8s.getByRole('button', { name: /How to install kubectl/ }))).toBeVisible();
});
