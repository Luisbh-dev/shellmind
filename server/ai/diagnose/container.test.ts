import { describe, expect, it } from 'vitest';
import { summarizeInspect } from './container';
import { textSection } from './sections';

const INSPECT = {
    Id: '3f4e5d6c7b8a9f0e1d2c',
    Name: '/web-proxy-1',
    Image: 'sha256:0123456789abcdef0123456789abcdef',
    RestartCount: 7,
    State: {
        Status: 'restarting',
        Restarting: true,
        OOMKilled: true,
        ExitCode: 137,
        Error: '',
        StartedAt: '2024-05-06T10:00:00Z',
        FinishedAt: '2024-05-06T10:00:05Z',
        Health: { Status: 'unhealthy', FailingStreak: 3, Log: [{ Start: 't1', End: 't1e', ExitCode: 1, Output: 'curl: (7) Failed to connect\n' }] }
    },
    Config: {
        Image: 'nginx:1.25',
        Env: ['POSTGRES_PASSWORD=hunter22', 'API_TOKEN=abc', 'PATH=/usr/bin'],
        Entrypoint: ['/docker-entrypoint.sh'],
        Cmd: ['nginx', '-g', 'daemon off;'],
        Labels: { 'com.docker.compose.project': 'web', 'com.docker.compose.service': 'proxy', secret: 'label-secret' }
    },
    HostConfig: { RestartPolicy: { Name: 'always', MaximumRetryCount: 0 }, Memory: 268435456, NanoCpus: 1500000000 },
    NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }], '443/tcp': null }, Networks: { web_default: { IPAddress: '172.18.0.2' } } },
    Mounts: [{ Type: 'bind', Source: '/srv/web/conf', Destination: '/etc/nginx/conf.d', RW: false }]
};

describe('summarizeInspect', () => {
    it('keeps what explains a failure and leaves the environment out entirely', () => {
        const text = summarizeInspect(INSPECT);
        expect(text).toContain('Name: web-proxy-1');
        expect(text).toContain('Image: nginx:1.25 sha256:0123456789ab');
        expect(text).toContain('State: restarting, exit code 137, killed by the kernel for running out of memory (OOMKilled)');
        expect(text).toContain('Restart count: 7');
        expect(text).toContain('Restart policy: always');
        expect(text).toContain('Health: unhealthy (failing streak 3)');
        expect(text).toContain('t1e exit 1: curl: (7) Failed to connect');
        expect(text).toContain('Command: nginx -g daemon off;');
        expect(text).toContain('Ports: 0.0.0.0:8080 -> 80/tcp; 443/tcp (not published)');
        expect(text).toContain('Networks: web_default (172.18.0.2)');
        expect(text).toContain('Mounts: /srv/web/conf -> /etc/nginx/conf.d (bind, ro)');
        expect(text).toContain('Limits: memory 256 MiB, cpus 1.5');
        expect(text).toContain('Compose project / service: web / proxy');
        expect(text).toContain('Environment: 3 variables, left out (they may hold secrets)');
        expect(text).not.toMatch(/hunter22|API_TOKEN|label-secret|POSTGRES/);
    });

    it('masks the credentials of its command line and health checks', () => {
        // As the evidence section has it (textSection redacts the whole text).
        const text = textSection({ id: 'container', title: 'Container state' }, summarizeInspect({
            Name: '/cache',
            State: { Status: 'running', Health: { Status: 'unhealthy', FailingStreak: 1, Log: [{ End: 't', ExitCode: 1, Output: 'redis-cli -a HealthPw99 ping: NOAUTH' }] } },
            Config: {
                Entrypoint: ['docker-entrypoint.sh'],
                Cmd: ['redis-server', '--requirepass', 'Hunter2 Redis', '--appendonly', 'yes', '--masterauth=MasterPw7']
            }
        }), 5000).text;
        expect(text).toContain('Command: redis-server --requirepass [REDACTED] --appendonly yes --masterauth=[REDACTED]');
        expect(text).toContain('redis-cli -a [REDACTED] ping: NOAUTH');
        expect(text).not.toMatch(/Hunter2|Redis --|MasterPw7|HealthPw99/);
    });

    it('copes with sparse or missing data', () => {
        expect(summarizeInspect(null)).toBe('(the engine returned no inspect data)');
        expect(summarizeInspect({ Name: '/x', State: { Status: 'exited', ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z' } })).toBe('Name: x\nState: exited, exit code 0');
    });
});
