import { describe, expect, it } from 'vitest';
import { detectLanguage, EDITOR_LANGUAGES, loadLanguage } from './languages';

describe('detectLanguage', () => {
    it.each([
        ['/etc/app/config.json', 'json'],
        ['/srv/docker-compose.yml', 'yaml'],
        ['/srv/app/index.mjs', 'javascript'],
        ['/srv/app/main.ts', 'typescript'],
        ['/srv/app/App.tsx', 'tsx'],
        ['/opt/tool/run.py', 'python'],
        ['/var/www/index.html', 'html'],
        ['/etc/app/pom.xml', 'xml'],
        ['/srv/README.md', 'markdown'],
        ['/srv/db/schema.sql', 'sql'],
        ['/usr/local/bin/backup.sh', 'shell'],
        ['/home/u/.bashrc', 'shell'],
        ['/etc/profile', 'shell'],
        ['/etc/bash.bashrc', 'shell'],
        ['/etc/zsh/zshrc', 'shell'],
        ['/etc/nginx/nginx.conf', 'nginx'],
        ['/etc/nginx/sites-available/default.conf', 'nginx'],
        ['/etc/sysctl.conf', 'ini'],
        ['/etc/php/php.ini', 'ini'],
        ['/srv/app/.env', 'ini'],
        ['/srv/app/.env.production', 'ini'],
        ['/etc/systemd/system/web.service', 'ini'],
        ['/srv/app/Cargo.toml', 'toml'],
        ['/srv/app/Dockerfile', 'dockerfile'],
        ['/srv/app/Dockerfile.prod', 'dockerfile'],
        ['/var/log/syslog', 'plain'],
        ['/srv/notes.txt', 'plain'],
    ])('%s -> %s', (path, language) => {
        expect(detectLanguage(path)).toBe(language);
    });
});

describe('loadLanguage', () => {
    it('loads every supported language', async () => {
        for (const language of EDITOR_LANGUAGES) {
            const extension = await loadLanguage(language);
            expect(extension).toBeDefined();
        }
    });
});
