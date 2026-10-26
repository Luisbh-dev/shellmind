import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAiMock } from './aiMock';
import {
    CONTAINER_PREFIX, buildImage, docker, dockerAvailable, inside, leftoverContainers, removeContainer, runSshContainer, sshBanner, waitUntil
} from './docker';
import { REPO_ROOT, startStack } from './stack';
import { STATE_VARIABLE, enabled, type E2EState, type Host, type HostName } from './state';

// Starts everything the specs drive: the sshd containers, the AI provider
// mock, then the backend and Vite. Returns the teardown, which stops the
// processes, removes the containers and keeps the app's logs next to the
// test results.

const HOST_IMAGE = `${CONTAINER_PREFIX}host`;
const DIND_IMAGE = `${CONTAINER_PREFIX}dind`;
const log = (line: string) => console.log(`[e2e-ui] ${line}`);

// The engine inside the Docker-in-Docker host gets alpine:3 from this
// machine (no registry needed) and one long-running container that logs.
function seedInnerEngine(container: string) {
    if (spawnSync('docker', ['image', 'inspect', 'alpine:3']).status !== 0) docker('pull', 'alpine:3');
    const image = execFileSync('docker', ['save', 'alpine:3'], { maxBuffer: 512 * 1024 * 1024 });
    execFileSync('docker', ['exec', '-i', container, 'docker', 'load'], { input: image, stdio: ['pipe', 'ignore', 'pipe'] });
    inside(container, [
        'set -e',
        `docker run -d --name e2e-web alpine:3 sh -c 'i=0; while :; do i=$((i+1)); echo "web tick $i"; sleep 0.5; done' >/dev/null`,
        'docker create --name e2e-idle alpine:3 true >/dev/null',
    ].join('\n'));
}

export default async function globalSetup(): Promise<() => Promise<void>> {
    if (!enabled()) throw new Error('The end-to-end UI suite is opt-in: set SHELLMIND_E2E_UI=1 (see test/e2e-ui/README.md).');
    // An environment that is already up (its state passed in, see the README):
    // the specs run against it and leave it running.
    if (process.env[STATE_VARIABLE]) return async () => {};
    if (!dockerAvailable()) throw new Error('The end-to-end UI suite needs Docker (docker info failed).');

    for (const name of leftoverContainers()) removeContainer(name);
    const started: string[] = [];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-e2eui-'));
    const mock = await startAiMock();
    let stopStack = async () => {};

    const teardown = async () => {
        await stopStack();
        await mock.close();
        for (const name of started) removeContainer(name);
        const logs = path.join(REPO_ROOT, 'test-results', 'e2e-ui-logs');
        fs.mkdirSync(logs, { recursive: true });
        for (const file of ['backend.log', 'vite.log']) {
            if (fs.existsSync(path.join(dataDir, file))) fs.copyFileSync(path.join(dataDir, file), path.join(logs, file));
        }
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    };

    try {
        log('building the test images');
        buildImage(HOST_IMAGE, path.join(REPO_ROOT, 'test', 'fixtures', 'e2e-ui', 'host'));
        buildImage(DIND_IMAGE, path.join(REPO_ROOT, 'test', 'fixtures', 'ops', 'containers-e2e'));

        const hosts = {} as Record<HostName, Host>;
        for (const name of ['alpha', 'beta', 'rekey'] as const) {
            const container = `${CONTAINER_PREFIX}${name}-${process.pid}`;
            started.push(container);
            hosts[name] = { container, port: runSshContainer(container, HOST_IMAGE) };
        }
        const dind = `${CONTAINER_PREFIX}dind-${process.pid}`;
        started.push(dind);
        hosts.dind = { container: dind, port: runSshContainer(dind, DIND_IMAGE, ['--privileged']) };

        for (const host of Object.values(hosts)) await waitUntil(() => sshBanner(host.port), 60_000, `sshd in ${host.container}`);
        await waitUntil(() => spawnSync('docker', ['exec', dind, 'docker', 'info']).status === 0, 90_000, 'the Docker engine in the Docker-in-Docker host');
        seedInnerEngine(dind);
        log(`containers up: ${Object.entries(hosts).map(([name, host]) => `${name}=:${host.port}`).join(' ')}`);

        const stack = await startStack({ dataDir, env: { MINIMAX_PROXY_URL: mock.url }, log });
        stopStack = stack.stop;
        const state: E2EState = { webUrl: stack.webUrl, apiUrl: stack.apiUrl, token: stack.token, aiMockUrl: mock.url, hosts };
        process.env[STATE_VARIABLE] = JSON.stringify(state);
        return teardown;
    } catch (error) {
        await teardown();
        throw error;
    }
}
