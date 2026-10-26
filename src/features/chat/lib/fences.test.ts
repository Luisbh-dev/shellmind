import { describe, expect, it } from 'vitest';
import { commandForBlock, isRunnableLanguage, normalizeFences, parseSegments, runnableCommands, type CodeSegment } from './fences';

const code = (lang: string, body: string, closed = true): CodeSegment => ({ type: 'code', lang, code: body, closed });

describe('parseSegments', () => {
    it('splits text and tagged blocks', () => {
        expect(parseSegments('Update first:\n```bash\nsudo apt update\n```\nThen reboot.')).toEqual([
            { type: 'text', text: 'Update first:' },
            code('bash', 'sudo apt update'),
            { type: 'text', text: 'Then reboot.' }
        ]);
    });

    it('treats a one-line fence as an untagged block instead of reading the command as a language', () => {
        expect(parseSegments('```ls -la```')).toEqual([code('', 'ls -la')]);
    });

    it('keeps heredocs, indentation, comments and blank lines exactly', () => {
        const body = "cat > docker-compose.yml <<'EOF'\nservices:\n  web:\n    image: nginx\n    # expose\n\n    ports:\n      - 80:80\nEOF";
        expect(parseSegments(`\`\`\`bash\n${body}\n\`\`\``)).toEqual([code('bash', body)]);
    });

    it('marks an unterminated (still streaming) block as open', () => {
        expect(parseSegments('Run:\n```bash\nrm -rf /tmp/build-ca')).toEqual([
            { type: 'text', text: 'Run:' },
            code('bash', 'rm -rf /tmp/build-ca', false)
        ]);
    });

    it('strips the indentation of blocks nested in lists and reads info strings', () => {
        expect(parseSegments('1. Check:\n   ```Bash title="x"\n   systemctl status nginx\n     --no-pager\n   ```\n2. Done')).toEqual([
            { type: 'text', text: '1. Check:' },
            code('bash', 'systemctl status nginx\n  --no-pager'),
            { type: 'text', text: '2. Done' }
        ]);
    });

    it('closes only on a matching fence and supports tildes', () => {
        expect(parseSegments('````md\n```bash\nls\n```\n````')).toEqual([code('md', '```bash\nls\n```')]);
        expect(parseSegments('~~~sh\necho hi\n~~~')).toEqual([code('sh', 'echo hi')]);
    });

    it('closes a block left open at the end of a complete answer', () => {
        expect(parseSegments('Run:\n```bash\nuptime', { complete: true })).toEqual([{ type: 'text', text: 'Run:' }, code('bash', 'uptime')]);
        expect(parseSegments('Run:\n```bash\nuptime')).toEqual([{ type: 'text', text: 'Run:' }, code('bash', 'uptime', false)]);
    });
});

describe('normalizeFences', () => {
    it('gives an opening fence glued to a sentence its own line', () => {
        // The answer that rendered as one paragraph and never ran.
        const answer = "El servidor está bien; reviso los recursos.```bash\nprintf '%s\\n' '=== SISTEMA ==='\nuname -a\n```";
        expect(normalizeFences(answer)).toBe("El servidor está bien; reviso los recursos.\n\n```bash\nprintf '%s\\n' '=== SISTEMA ==='\nuname -a\n```");
        expect(parseSegments(answer)).toEqual([
            { type: 'text', text: 'El servidor está bien; reviso los recursos.\n' },
            code('bash', "printf '%s\\n' '=== SISTEMA ==='\nuname -a")
        ]);
        expect(runnableCommands(answer, {})).toEqual(["printf '%s\\n' '=== SISTEMA ==='\nuname -a"]);
    });

    it('gives a closing fence glued to the last command its own line', () => {
        expect(parseSegments('```bash\nuptime\nfree -m```\nDone.')).toEqual([code('bash', 'uptime\nfree -m'), { type: 'text', text: 'Done.' }]);
        expect(parseSegments('Check:~~~sh\necho hi~~~')).toEqual([{ type: 'text', text: 'Check:\n' }, code('sh', 'echo hi')]);
    });

    it('ends a block at a closing fence followed by text, so the text never runs', () => {
        const glued = 'Reviso el kernel:\n```bash\nuname -a\n```Con esto verás la versión; luego borra /tmp/x si sobra.';
        expect(parseSegments(glued, { complete: true })).toEqual([
            { type: 'text', text: 'Reviso el kernel:' },
            code('bash', 'uname -a'),
            { type: 'text', text: 'Con esto verás la versión; luego borra /tmp/x si sobra.' }
        ]);
        expect(runnableCommands(glued, {}, { complete: true })).toEqual(['uname -a']);
        const spaced = 'Reviso:\n```bash\ndf -h\n``` y después te digo.';
        expect(runnableCommands(spaced, {}, { complete: true })).toEqual(['df -h']);
        expect(runnableCommands('Check:\n~~~sh\nfree -m\n~~~ Done, nothing else to run.', {}, { complete: true })).toEqual(['free -m']);
        // The text may open the next block.
        expect(runnableCommands('```bash\nuptime\n```Now the disks:```bash\ndf -h\n```', {})).toEqual(['uptime', 'df -h']);
        // In a scoped console untagged blocks run: the text must not.
        expect(runnableCommands('```\nps -a\n```Listo, eso es todo.', { scopedBin: 'docker' }, { complete: true })).toEqual(['ps -a']);
    });

    it('keeps a fence with a bare info string inside a block as code', () => {
        // A closing fence cannot carry an info string (CommonMark).
        expect(parseSegments('```bash\necho start\n```bash\necho end\n```')).toEqual([code('bash', 'echo start\n```bash\necho end')]);
        expect(parseSegments('````md\n```bash\nls\n```\n````')).toEqual([code('md', '```bash\nls\n```')]);
    });

    it('reads CRLF answers', () => {
        expect(parseSegments('Run:\r\n```bash\r\nls -la\r\n```\r\n')).toEqual([{ type: 'text', text: 'Run:' }, code('bash', 'ls -la')]);
    });

    it('leaves fences in inline code, in code blocks and in prose alone', () => {
        for (const text of ['Use `` ```bash `` to open a block.', 'Type ``` ```bash', 'Close it with ```']) {
            expect(normalizeFences(text)).toBe(text);
        }
        const nested = '````md\nIntro:```bash\nls\n````';
        expect(normalizeFences(nested)).toBe(nested);
        const quoted = '```bash\necho "open with ```bash"\n```';
        expect(parseSegments(quoted)).toEqual([code('bash', 'echo "open with ```bash"')]);
    });

    it('keeps indented blocks of lists working', () => {
        expect(parseSegments('1. Install:```bash\n   apt install -y nginx\n   ```\n2. Done')).toEqual([
            { type: 'text', text: '1. Install:\n' },
            code('bash', '   apt install -y nginx'),
            { type: 'text', text: '2. Done' }
        ]);
        expect(parseSegments('- Check:\n  ```bash\n  systemctl status nginx```')).toEqual([
            { type: 'text', text: '- Check:' },
            code('bash', 'systemctl status nginx')
        ]);
    });
});

describe('isRunnableLanguage', () => {
    it('runs shell languages only', () => {
        for (const lang of ['bash', 'sh', 'zsh', 'shell', 'console', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']) {
            expect(isRunnableLanguage(lang, {})).toBe(true);
        }
        for (const lang of ['', 'yaml', 'json', 'text', 'output', 'python', 'ini', 'nginx', 'sql', 'dockerfile']) {
            expect(isRunnableLanguage(lang, {})).toBe(false);
        }
    });

    it('runs untagged blocks in scoped and FTP consoles', () => {
        expect(isRunnableLanguage('', { scopedBin: 'docker' })).toBe(true);
        expect(isRunnableLanguage('docker', { scopedBin: 'docker' })).toBe(true);
        expect(isRunnableLanguage('yaml', { scopedBin: 'docker' })).toBe(false);
        expect(isRunnableLanguage('', { ftp: true })).toBe(true);
    });
});

describe('commandForBlock', () => {
    it('sends the exact block', () => {
        expect(commandForBlock(code('bash', '#!/bin/bash\n  indented # comment\n'))).toBe('#!/bin/bash\n  indented # comment');
    });

    it('keeps only the prompt lines of a console transcript', () => {
        expect(commandForBlock(code('console', '$ uptime\n 10:00 up 3 days\n$ df -h /\nFilesystem Size'))).toBe('uptime\ndf -h /');
        expect(commandForBlock(code('console', 'docker ps'))).toBe('docker ps');
        expect(commandForBlock(code('console', 'PS C:\\> Get-Service sshd\nStatus   Name\nRunning  sshd'))).toBe('Get-Service sshd');
    });

    it('reads user@host and root prompts', () => {
        expect(commandForBlock(code('console', 'root@web:~# apt update\nHit:1 http://archive.ubuntu.com\nroot@web:/etc# systemctl restart nginx'))).toBe('apt update\nsystemctl restart nginx');
        expect(commandForBlock(code('shell-session', 'admin@db-1:~$ psql -c "\\l"\n[root@centos ~]# yum check-update'))).toBe('psql -c "\\l"\nyum check-update');
    });

    it('never runs a comment as a command', () => {
        // "# " next to "$ " prompts is a comment.
        expect(runnableCommands('```console\n# Check the disk usage\n$ df -h\n```', {})).toEqual(['df -h']);
        expect(commandForBlock(code('console', '# disk usage first\n$ df -h\n# then memory\n$ free -m'))).toBe('df -h\nfree -m');
        // A bare "# " transcript is a root shell, unless the line reads like prose.
        expect(commandForBlock(code('console', '# apt update\nReading package lists... Done'))).toBe('apt update');
        expect(commandForBlock(code('console', '# Update the package lists first.\napt update'))).toBe('# Update the package lists first.\napt update');
    });
});

describe('runnableCommands', () => {
    it('collects complete runnable blocks only', () => {
        const answer = 'Output:\n```text\nerror: x\n```\nFix:\n```bash\nsystemctl restart nginx\n```\nConfig:\n```yaml\nkey: value\n```\n```bash\nsudo rm -rf /tmp/x';
        expect(runnableCommands(answer, {})).toEqual(['systemctl restart nginx']);
        // A complete answer whose last block lacks its closing fence.
        expect(runnableCommands(answer, {}, { complete: true })).toEqual(['systemctl restart nginx', 'sudo rm -rf /tmp/x']);
    });
});
