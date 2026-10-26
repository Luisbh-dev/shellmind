import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testCaps } from '../../test/helpers/opsCaps';
import {
    engineCommand,
    listContainersScript,
    parseComposeProjects,
    parseContainerList,
    parseContainerRecords,
    parseContainerStats,
    parseDockerPs,
    parseLabels,
    parsePodmanPs,
    prepareContainerAction,
    requireEngine,
    stateFromStatus,
    summarizeInspect,
} from './containers';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/ops/${name}`, import.meta.url)), 'utf8');

const PODMAN_PS = JSON.stringify([{
    AutoRemove: false,
    Command: ['nginx', '-g', 'daemon off;'],
    Created: 1714557600,
    CreatedAt: '3 days ago',
    Exited: false,
    Id: 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44',
    Image: 'docker.io/library/nginx:latest',
    Labels: { 'io.podman.compose.project': 'site', 'com.docker.compose.service': 'web' },
    Names: ['site_web_1'],
    Ports: [{ host_ip: '', container_port: 80, host_port: 8080, range: 1, protocol: 'tcp' }],
    State: 'running',
    Status: 'Up 3 days',
}]);

describe('container state of older engines', () => {
    it('derives the state from the status text when `docker ps` has no State (Docker < 20.10)', () => {
        const containers = parseDockerPs(fixture('docker-ps-legacy.jsonl'));
        expect(containers.map((container) => [container.name, container.state])).toEqual([
            ['legacy-web', 'running'],
            ['legacy-cache', 'paused'],
            ['legacy-worker', 'restarting'],
            ['legacy-migrate', 'exited'],
            ['legacy-new', 'created'],
        ]);
        expect(containers[3].status).toBe('Exited (137) 3 days ago');
    });

    it('maps every status Docker prints', () => {
        expect(stateFromStatus('Up 3 days (healthy)')).toBe('running');
        expect(stateFromStatus('Up About a minute (Paused)')).toBe('paused');
        expect(stateFromStatus('Removal In Progress')).toBe('removing');
        expect(stateFromStatus('Dead')).toBe('dead');
        expect(stateFromStatus('')).toBe('unknown');
    });
});

describe('container lists', () => {
    it('parses `docker ps --format {{json .}}` lines with compose labels', () => {
        const containers = parseDockerPs(fixture('docker-ps.jsonl'));
        expect(containers).toHaveLength(3);
        expect(containers[0]).toEqual({
            id: '3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e',
            name: 'web-proxy-1',
            image: 'nginx:1.25',
            state: 'running',
            status: 'Up 3 days',
            ports: '0.0.0.0:80->80/tcp, :::80->80/tcp',
            createdAt: '2024-05-01 10:00:00 +0000 UTC',
            composeProject: 'web',
            composeService: 'proxy',
        });
        expect(containers[1]).toMatchObject({ name: 'old-job', state: 'exited', composeProject: null });
    });

    it('parses `podman ps --format json`', () => {
        expect(parsePodmanPs(PODMAN_PS)).toEqual([{
            id: 'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44',
            name: 'site_web_1',
            image: 'docker.io/library/nginx:latest',
            state: 'running',
            status: 'Up 3 days',
            ports: '0.0.0.0:8080->80/tcp',
            createdAt: '2024-05-01T10:00:00.000Z',
            composeProject: 'site',
            composeService: 'web',
        }]);
    });

    it('sorts running containers first and reads compose projects and the exit status', () => {
        const output = `\n@@SM:ps\n${fixture('docker-ps.jsonl')}\n@@SM:rc\n0\n@@SM:compose\n[{"Name":"web","Status":"running(2)","ConfigFiles":"/srv/web/compose.yaml"}]\n@@SM:end\n`;
        const { list, exitCode } = parseContainerList('docker', output);
        expect(exitCode).toBe(0);
        expect(list.containers.map((container) => container.name)).toEqual(['web-db-1', 'web-proxy-1', 'old-job']);
        expect(list.projects).toEqual([{ name: 'web', status: 'running(2)', configFiles: '/srv/web/compose.yaml' }]);
        expect(parseComposeProjects(undefined)).toEqual([]);
    });

    it('builds the listing script for the detected engine', () => {
        const docker = listContainersScript(requireEngine(testCaps()));
        expect(docker).toContain("docker 'ps' '-a' '--no-trunc' '--format' '{{json .}}' 2>&1");
        expect(docker).toContain("docker 'compose' 'ls' '-a' '--format' 'json'");
        const podman = listContainersScript(requireEngine(testCaps({ containers: { engine: 'podman', compose: false } })));
        expect(podman).toContain("podman 'ps' '-a' '--format' 'json'");
        expect(podman).not.toContain('compose');
        const windows = listContainersScript(requireEngine(testCaps({ platform: 'windows' })));
        expect(windows).toContain("& docker 'ps' '-a' '--no-trunc' '--format' '{{json .}}' 2>&1");
    });

    it('explains a missing engine', () => {
        expect(() => requireEngine(testCaps({ containers: { engine: null, problem: 'Docker is not installed.' } }))).toThrow('Docker is not installed.');
    });
});

describe('container stats', () => {
    it('parses Docker and Podman stats', () => {
        const docker = parseContainerStats('docker', '{"BlockIO":"12.3MB / 4.1kB","CPUPerc":"0.12%","Container":"3f4e5d6c7b8a","ID":"3f4e5d6c7b8a","MemPerc":"0.35%","MemUsage":"27.5MiB / 7.66GiB","Name":"web-proxy-1","NetIO":"1.45MB / 2.3MB","PIDs":"5"}\n');
        expect(docker).toEqual([{
            id: '3f4e5d6c7b8a', name: 'web-proxy-1', cpuPercent: 0.12, memoryPercent: 0.35, memoryUsage: '27.5MiB / 7.66GiB', netIO: '1.45MB / 2.3MB', blockIO: '12.3MB / 4.1kB', pids: 5,
        }]);
        const podman = parseContainerStats('podman', '[{"id":"aa11bb22cc33","name":"site_web_1","cpu_percent":"1.50%","mem_usage":"10MB / 8GB","mem_percent":"0.12%","net_io":"1kB / 2kB","block_io":"0B / 0B","pids":"3"}]');
        expect(podman[0]).toMatchObject({ id: 'aa11bb22cc33', cpuPercent: 1.5, memoryPercent: 0.12, pids: 3 });
    });
});

describe('container actions', () => {
    it('builds engine commands from validated references', () => {
        expect(prepareContainerAction(testCaps(), 'web-proxy-1', 'restart')).toMatchObject({
            display: "docker 'restart' 'web-proxy-1'",
            meta: { kind: 'container', action: 'restart', target: 'web-proxy-1' },
        });
        expect(prepareContainerAction(testCaps(), 'web-proxy-1', 'remove').display).toBe("docker 'rm' '-f' 'web-proxy-1'");
        expect(prepareContainerAction(testCaps({ containers: { sudo: true } }), 'abc123', 'stop').display).toBe("sudo -n docker 'stop' 'abc123'");
        expect(prepareContainerAction(testCaps({ platform: 'windows' }), 'web', 'start').display).toBe("docker 'start' 'web'");
        expect(engineCommand(requireEngine(testCaps({ platform: 'windows' })), ['logs', 'web'])).toBe("& docker 'logs' 'web'");
    });

    it('refuses references and actions outside the allowed set', () => {
        for (const ref of ['web; reboot', '-f', '../x', "a'b", 'a b', '']) {
            expect(() => prepareContainerAction(testCaps(), ref, 'start'), ref).toThrow(/not a valid container/);
        }
        expect(() => prepareContainerAction(testCaps(), 'web', 'exec')).toThrow(/not a container action/);
    });
});

describe('labels (W7-S3)', () => {
    it('keeps the commas inside a value of Docker\'s label string', () => {
        expect(parseLabels('com.docker.compose.project=web,com.docker.compose.project.config_files=/srv/web/compose.yaml,/srv/web/compose.prod.yaml,app.kubernetes.io/name=api,empty=')).toEqual({
            'com.docker.compose.project': 'web',
            'com.docker.compose.project.config_files': '/srv/web/compose.yaml,/srv/web/compose.prod.yaml',
            'app.kubernetes.io/name': 'api',
            empty: '',
        });
        expect(parseLabels({ a: 'b', n: 1 })).toEqual({ a: 'b', n: '1' });
        expect(parseLabels('')).toEqual({});
        expect(parseLabels(null)).toEqual({});
    });

    it('lists containers with all their labels', () => {
        const records = parseContainerRecords('docker', fixture('docker-ps.jsonl'));
        expect(records[0].labels).toMatchObject({ 'com.docker.compose.project': 'web', 'com.docker.compose.service': 'proxy' });
        expect(parseContainerRecords('podman', PODMAN_PS)[0].labels).toEqual({ 'io.podman.compose.project': 'site', 'com.docker.compose.service': 'web' });
    });
});

describe('inspect summary (W7-S3)', () => {
    it('summarizes what the container panel shows', () => {
        const [inspect] = JSON.parse(fixture('docker-inspect.json')) as unknown[];
        expect(summarizeInspect(inspect)).toEqual({
            id: 'fde9ade5780c770cb294944bbf33bdad30ee2bced0a93ecc164b324800f0037d',
            name: 'demo-web-1',
            image: 'busybox:1.36',
            imageId: 'sha256:b116e155074440ffd9e449559433feb4cd2341eb3554b1da1c638c976e56451d',
            created: '2026-10-24T15:18:17.405471798Z',
            state: { status: 'running', running: true, exitCode: 0, oomKilled: false, error: null, startedAt: '2026-10-24T15:18:19.006964572Z', finishedAt: null, pid: 587 },
            restartPolicy: 'on-failure:5',
            restartCount: 2,
            command: 'sleep infinity',
            workingDir: null,
            user: null,
            env: [
                { name: 'DB_PASSWORD', value: 'hunter2' },
                { name: 'EMPTY', value: '' },
                { name: 'URL', value: 'postgres://u:p@db/x?a=b' },
                { name: 'PATH', value: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
            ],
            mounts: [
                { type: 'bind', name: null, source: '/srv/demo', destination: '/app', readOnly: true },
                { type: 'volume', name: 'demo_data', source: '/var/lib/docker/volumes/demo_data/_data', destination: '/data', readOnly: false },
            ],
            // IPv4 and IPv6 bindings of one port read as one; an exposed port has no host side.
            ports: [{ port: '80/tcp', hostIp: '0.0.0.0', hostPort: '8080' }, { port: '9000/tcp', hostIp: null, hostPort: null }],
            networkMode: 'demo_default',
            networks: [{ name: 'demo_default', ipAddress: '172.19.0.3', gateway: '172.19.0.1', macAddress: '92:13:72:a1:75:90', aliases: ['demo-web-1', 'web', 'fde9ade5780c'] }],
            health: {
                status: 'healthy',
                failingStreak: 0,
                log: [{ start: '2026-10-24T15:18:24.374533498Z', exitCode: 0, output: '' }, { start: '2026-10-24T15:18:29.483535436Z', exitCode: 0, output: 'ok' }],
            },
            compose: { project: 'demo', service: 'web', workingDir: '/srv/demo', configFiles: ['/srv/demo/compose.yaml', '/srv/demo/compose.prod.yaml'] },
        });
    });

    it('reads a stopped Podman container without health or networks', () => {
        const summary = summarizeInspect({
            Id: 'aa11', Name: 'job', ImageName: 'docker.io/library/alpine:3', Path: 'sh', Args: ['-c', 'exit 3'],
            State: { Status: 'exited', Running: false, ExitCode: 3, OOMKilled: true, FinishedAt: '2026-10-24T10:00:00Z', Healthcheck: { Status: '' } },
            Config: { Env: null, Labels: { 'io.podman.compose.project': 'site' } },
            HostConfig: { NetworkMode: 'none', PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] } },
            NetworkSettings: { Ports: {} },
        });
        expect(summary).toMatchObject({
            name: 'job', image: 'docker.io/library/alpine:3', command: 'sh -c exit 3',
            state: { status: 'exited', running: false, exitCode: 3, oomKilled: true, finishedAt: '2026-10-24T10:00:00Z' },
            env: [], health: null, networks: [], networkMode: 'none', restartPolicy: null,
            ports: [{ port: '80/tcp', hostIp: null, hostPort: '8080' }],
            compose: { project: 'site', service: null, workingDir: null, configFiles: [] },
        });
        expect(summarizeInspect(null)).toBeNull();
    });
});
