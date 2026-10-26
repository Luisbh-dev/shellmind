import { describe, expect, it } from 'vitest';
import { testCaps } from '../../test/helpers/opsCaps';
import {
    composeActionSteps,
    composeDiscoveryScript,
    composeInvocation,
    groupProjects,
    missingPathsScript,
    parseComposeDiscovery,
    type DiscoveredProject,
} from './compose';
import { parseContainerRecords, requireEngine } from './containers';

// W7-S3: Compose projects from their containers' labels, and the commands of
// their actions.

function psLine(name: string, labels: Record<string, string>, extra: Record<string, string> = {}): string {
    return JSON.stringify({
        ID: `${name}-id`,
        Names: name,
        Image: 'alpine:3',
        State: 'running',
        Status: 'Up 1 minute',
        CreatedAt: '2026-10-24 15:18:17 +0000 UTC',
        Labels: Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(','),
        ...extra,
    });
}

const shopLabels = (service: string) => ({
    'com.docker.compose.project': 'shop',
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': '/srv/shop',
    'com.docker.compose.project.config_files': '/srv/shop/compose.yaml,/srv/shop/compose.prod.yaml',
});

const PS = [
    psLine('shop-web-1', shopLabels('web')),
    psLine('shop-db-1', { ...shopLabels('db'), 'com.docker.compose.project.environment_file': '/srv/shop/.env.prod' }, { State: 'exited', Status: 'Exited (1) 1 minute ago' }),
    // Compose v1 wrote the files as given (relative to the working directory).
    psLine('legacy_app_1', { 'com.docker.compose.project': 'legacy', 'com.docker.compose.service': 'app', 'com.docker.compose.project.working_dir': '/opt/legacy', 'com.docker.compose.project.config_files': 'docker-compose.yml' }),
    psLine('odd-app-1', { 'com.docker.compose.project': 'odd', 'com.docker.compose.service': 'app', 'com.docker.compose.project.working_dir': "/srv/it's here", 'com.docker.compose.project.config_files': '/srv/odd/../etc/compose.yaml' }),
].join('\n');

const docker = requireEngine(testCaps());

function project(name: string): DiscoveredProject {
    const found = groupProjects(parseContainerRecords('docker', PS)).find((entry) => entry.name === name);
    if (!found) throw new Error(name);
    return found;
}

describe('compose discovery', () => {
    it('groups containers by project with the directory and files of the latest up', () => {
        const projects = groupProjects(parseContainerRecords('docker', PS));
        expect(projects.map((entry) => entry.name)).toEqual(['legacy', 'odd', 'shop']);
        expect(project('shop')).toMatchObject({
            workingDir: '/srv/shop',
            configFiles: ['/srv/shop/compose.yaml', '/srv/shop/compose.prod.yaml'],
            envFiles: [],
            invalidPaths: [],
        });
        // Sorted by service.
        expect(project('shop').records.map((record) => record.info.name)).toEqual(['shop-db-1', 'shop-web-1']);
        expect(project('legacy').configFiles).toEqual(['/opt/legacy/docker-compose.yml']);
    });

    it('does not use paths that are not plain absolute paths', () => {
        expect(project('odd')).toMatchObject({ workingDir: null, configFiles: [], invalidPaths: ["/srv/it's here", '/srv/odd/../etc/compose.yaml'] });
    });

    it('lists the containers of every project and finds the Compose of Podman', () => {
        expect(composeDiscoveryScript(docker)).toContain("docker 'ps' '-a' '--no-trunc' '--filter' 'label=com.docker.compose.project' '--format' '{{json .}}' 2>&1");
        expect(composeDiscoveryScript(docker)).not.toContain('podman-compose');
        const podman = requireEngine(testCaps({ containers: { engine: 'podman', compose: false } }));
        expect(composeDiscoveryScript(podman)).toContain("podman 'ps' '-a' '--filter' 'label=com.docker.compose.project' '--format' 'json'");
        expect(parseComposeDiscovery(podman, '\n@@SM:ps\n[]\n@@SM:rc\n0\n@@SM:tool\npodman-compose\n@@SM:end\n')).toMatchObject({ tool: 'podman-compose', exitCode: 0, projects: [] });
        expect(parseComposeDiscovery(podman, '\n@@SM:ps\n[]\n@@SM:rc\n0\n@@SM:tool\n\n@@SM:end\n').tool).toBeNull();
        expect(parseComposeDiscovery(requireEngine(testCaps({ containers: { compose: false } })), `\n@@SM:ps\n${PS}\n@@SM:rc\n0\n@@SM:end\n`).tool).toBeNull();
        expect(parseComposeDiscovery(docker, `\n@@SM:ps\n${PS}\n@@SM:rc\n0\n@@SM:end\n`).projects).toHaveLength(3);
    });

    it('checks the files with the privileges the engine reads them with', () => {
        const script = missingPathsScript(requireEngine(testCaps({ containers: { sudo: true } })), [project('shop')]);
        expect(script).toContain("sudo -n test -d '/srv/shop' || printf '%s\\n' '/srv/shop'");
        expect(script).toContain("sudo -n test -r '/srv/shop/compose.prod.yaml' || printf '%s\\n' '/srv/shop/compose.prod.yaml'");
        expect(missingPathsScript(docker, [project('odd')])).toBeNull();
    });
});

describe('compose invocation', () => {
    it('passes the project, its directory and its files', () => {
        const invocation = composeInvocation(docker, 'docker compose', project('shop'), true, new Set());
        expect(invocation.cwd).toBe('/');
        expect(invocation.command(['up', '-d'])).toBe("docker 'compose' '-p' 'shop' '--project-directory' '/srv/shop' '-f' '/srv/shop/compose.yaml' '-f' '/srv/shop/compose.prod.yaml' 'up' '-d'");
        const withEnv = composeInvocation(docker, 'docker compose', { ...project('shop'), envFiles: ['/srv/shop/.env.prod'] }, true, new Set());
        expect(withEnv.command(['pull'])).toContain("'--env-file' '/srv/shop/.env.prod' 'pull'");
    });

    it('works by name alone without the files, except for up and update', () => {
        const missing = new Set(['/srv/shop/compose.prod.yaml']);
        expect(composeInvocation(docker, 'docker compose', project('shop'), false, missing).command(['stop'])).toBe("docker 'compose' '-p' 'shop' 'stop'");
        expect(() => composeInvocation(docker, 'docker compose', project('shop'), true, missing))
            .toThrow(expect.objectContaining({ code: 'COMPOSE_FILES_MISSING', status: 409, details: { project: 'shop', files: '/srv/shop/compose.prod.yaml' } }));
        expect(() => composeInvocation(docker, 'docker compose', project('odd'), true, new Set())).toThrow(/not on the server any more/);
    });

    it('runs podman-compose from the project directory, and only with its files', () => {
        const podman = requireEngine(testCaps({ containers: { engine: 'podman', compose: false } }));
        const invocation = composeInvocation(podman, 'podman-compose', project('shop'), false, new Set());
        expect(invocation.cwd).toBe('/srv/shop');
        expect(invocation.command(['restart', 'web'])).toBe("podman-compose '-p' 'shop' '-f' '/srv/shop/compose.yaml' '-f' '/srv/shop/compose.prod.yaml' 'restart' 'web'");
        expect(composeInvocation(podman, 'podman compose', project('shop'), false, new Set()).command(['stop'])).toBe("podman 'compose' '-p' 'shop' '-f' '/srv/shop/compose.yaml' '-f' '/srv/shop/compose.prod.yaml' 'stop'");
        expect(() => composeInvocation(podman, 'podman-compose', project('shop'), false, new Set(['/srv/shop']))).toThrow(/not on the server any more/);
    });

    it('turns actions into Compose steps, never removing volumes or images', () => {
        expect(composeActionSteps('up')).toEqual([['up', '-d']]);
        expect(composeActionSteps('update', 'web')).toEqual([['pull', 'web'], ['up', '-d', 'web']]);
        expect(composeActionSteps('restart', 'web')).toEqual([['restart', 'web']]);
        expect(composeActionSteps('stop')).toEqual([['stop']]);
        expect(composeActionSteps('down')).toEqual([['down']]);
    });
});
