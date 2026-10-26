import { describe, expect, it } from 'vitest';
import {
    fillPlaceholders,
    isSensitiveVariable,
    maskPlaceholders,
    maskSecretValues,
    missingVariables,
    parsePlaceholders,
    resolveValue,
    rewriteAroundPlaceholders,
    secretValues,
    secretVariableNames,
    unmarkedVariableNames
} from './placeholders';

const variable = (name: string, defaultValue: string | null, secret = false, declaredSecret = false) => ({ name, defaultValue, secret, declaredSecret });

describe('parsePlaceholders', () => {
    it('finds variables with and without defaults in order of first use', () => {
        expect(parsePlaceholders('tail -n {{lines:200}} {{ file }} | grep {{pattern}} | head -n {{lines}}')).toEqual([
            variable('lines', '200'),
            variable('file', null),
            variable('pattern', null),
        ]);
    });

    it('keeps the first default given for a name, even when it comes later', () => {
        expect(parsePlaceholders('{{host}} {{host:localhost}} {{host:other}}')).toEqual([variable('host', 'localhost')]);
    });

    it('accepts defaults with colons, slashes and spaces, and explicit empty defaults', () => {
        expect(parsePlaceholders('curl {{url:http://localhost:8080/health}} {{ path : /var/log }} {{flags:}}')).toEqual([
            variable('url', 'http://localhost:8080/health'),
            variable('path', '/var/log'),
            variable('flags', ''),
        ]);
    });

    it('ignores Go templates, escaped placeholders and malformed braces', () => {
        const docker = "docker ps --format 'table {{.Names}}\\t{{.Status}}' && docker inspect -f '{{json .State}}' web";
        expect(parsePlaceholders(docker)).toEqual([]);
        expect(parsePlaceholders('echo \\{{literal}} {{1abc}} {{ }} {single} {{a b}}')).toEqual([]);
        expect(parsePlaceholders('multi\nline {{first}}\n  indented {{second_one}} {{log-file}}').map((v) => v.name)).toEqual([
            'first', 'second_one', 'log-file',
        ]);
    });

    it('leaves the bare words of Go templates (range/if … end, else) alone', () => {
        expect(parsePlaceholders("docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' {{container}}")).toEqual([variable('container', null)]);
        expect(parsePlaceholders("docker ps --format '{{if .Ports}}{{.Ports}}{{else}}none{{ end }}'")).toEqual([]);
        expect(parsePlaceholders("kubectl get pods -o go-template='{{range .items}}{{.metadata.name}}{{println}}{{end}}'")).toEqual([]);
        // Written with a default, a template word is a variable like any other.
        expect(parsePlaceholders('head -n {{end:5}}')).toEqual([variable('end', '5')]);
    });

    it('marks secrets: declared with :secret (no default), or named like one (its default kept)', () => {
        expect(parsePlaceholders('login {{user}} {{password}} {{api_token}} {{AUTH_KEY}} {{otp}} {{pin}} {{ping_host}}')).toEqual([
            variable('user', null),
            variable('password', null, true),
            variable('api_token', null, true),
            variable('AUTH_KEY', null, true),
            variable('otp', null, true),
            variable('pin', null, true),
            variable('ping_host', null),
        ]);
        expect(parsePlaceholders('curl -u admin:{{pw:hunter2}} {{note:secret}} {{label}} {{label:SECRET}}')).toEqual([
            variable('pw', 'hunter2', true),
            variable('note', null, true, true),
            variable('label', null, true, true),
        ]);
    });

    it('keeps ordinary variables whose names only contain a secret-looking word', () => {
        const command = 'cat {{authorized_keys:~/.ssh/authorized_keys}} | grep {{keyword:ssh-ed25519}} | head -n {{spin:5}} {{author}} {{auth_type:basic}} {{hotkey}} {{bypass}}';
        expect(parsePlaceholders(command)).toEqual([
            variable('authorized_keys', '~/.ssh/authorized_keys'),
            variable('keyword', 'ssh-ed25519'),
            variable('spin', '5'),
            variable('author', null),
            variable('auth_type', 'basic'),
            variable('hotkey', null),
            variable('bypass', null),
        ]);
        expect(secretVariableNames(command).size).toBe(0);
        expect(missingVariables(parsePlaceholders(command), {})).toEqual(['author', 'hotkey', 'bypass']);
        // Their values are output like any other: nothing to mask.
        expect(maskSecretValues('ssh-ed25519 AAAA root@web', secretValues({ keyword: 'ssh-ed25519' }, secretVariableNames(command)))).toBe('ssh-ed25519 AAAA root@web');
    });

    it('reads names as words in any case style', () => {
        for (const name of ['password', 'db_pass', 'dbPassword', 'DB_PASSWD', 'rootpw', 'MYSQL_PWD', 'db_passphrase', 'clientSecret', 'GITHUB_TOKEN',
            'apiKey', 'APIKey', 'x-api-key', 'ssh_private_key', 'AUTH_KEY', 'otp_code', 'sim_pin', 'pin2', 'session_cookie', 'creds', 'credentials']) {
            expect(isSensitiveVariable(name), name).toBe(true);
        }
        for (const name of ['hostname', 'keyword', 'authorized_keys', 'ssh_key_path', 'spin', 'author', 'auth_type', 'hotkey', 'passenger', 'compass', 'pinned', 'keys']) {
            expect(isSensitiveVariable(name), name).toBe(false);
        }
    });

    it('lets the user unmark a secret-looking variable, but not a declared secret', () => {
        const command = 'deploy --pin {{pin:v2}} --token {{token}} --key {{key:secret}} --env {{env}}';
        expect([...secretVariableNames(command)].sort()).toEqual(['key', 'pin', 'token']);
        expect([...secretVariableNames(command, { unmarked: ['pin', 'key'], marked: ['env'] })].sort()).toEqual(['env', 'key', 'token']);
        // What the user unmarked, read back from the names that stayed secret.
        expect(unmarkedVariableNames(command, ['key', 'token', 'env'])).toEqual(['pin']);
    });
});

describe('rewriteAroundPlaceholders', () => {
    const upper = (text: string) => text.toUpperCase();

    it('rewrites the text and leaves the placeholders as they were', () => {
        expect(rewriteAroundPlaceholders('echo {{name:Ann}} and \\{{literal}} {{other}}', upper)).toBe('ECHO {{name:Ann}} AND \\{{literal}} {{other}}');
    });

    it('fails when the rewrite drops or changes a placeholder', () => {
        expect(rewriteAroundPlaceholders('echo {{a}} {{b}}', (text) => text.replace(/\S+$/, 'X'))).toBeNull();
        expect(rewriteAroundPlaceholders('echo {{a}}x', (text) => text.replace(/\S+$/, 'X'))).toBeNull();
        expect(rewriteAroundPlaceholders('echo {{a}}', (text) => `${text} ${text}`)).toBeNull();
    });
});

describe('fillPlaceholders', () => {
    it('replaces every occurrence with the typed value or the default', () => {
        expect(fillPlaceholders('ps aux --sort=-%mem | head -n {{count:15}} # {{count}}', {})).toBe('ps aux --sort=-%mem | head -n 15 # 15');
        expect(fillPlaceholders('ping -c {{count:4}} {{host}}', { host: '10.0.0.1', count: '' })).toBe('ping -c 4 10.0.0.1');
        expect(fillPlaceholders('ping -c {{count:4}} {{host}}', { host: 'db', count: '1' })).toBe('ping -c 1 db');
    });

    it('leaves Go templates untouched and unescapes escaped placeholders', () => {
        expect(fillPlaceholders("docker ps --format '{{.Names}}' {{name}} \\{{name}}", { name: 'web' })).toBe("docker ps --format '{{.Names}}' web {{name}}");
        expect(fillPlaceholders("docker ps -f name={{name}} --format '{{if .Ports}}{{.Ports}}{{else}}none{{end}}'", { name: 'web', end: 'x', else: 'y' }))
            .toBe("docker ps -f name=web --format '{{if .Ports}}{{.Ports}}{{else}}none{{end}}'");
        // A bare {{end}} stays a template word even next to a variable named end.
        expect(fillPlaceholders('{{end:5}} {{end}}', {})).toBe('5 {{end}}');
    });

    it('inserts values literally, including $ patterns and quotes', () => {
        expect(fillPlaceholders('echo {{msg}}', { msg: "$& $1 'quoted'" })).toBe("echo $& $1 'quoted'");
    });

    it('fills a missing required variable with an empty string, and a :secret one with its value', () => {
        expect(fillPlaceholders('ls {{dir}}', {})).toBe('ls ');
        expect(fillPlaceholders('curl -H "X-Key: {{key:secret}}"', { key: 'k-123' })).toBe('curl -H "X-Key: k-123"');
    });
});

describe('the recorded form', () => {
    it('keeps the placeholder of every secret variable and fills in the rest', () => {
        const command = 'mysql -u {{user:root}} -p{{password}} -h {{host}} -e "{{query:secret}}" # {{password}}';
        const values = { password: 'S3cr3t!', host: 'db-1', query: 'drop table x' };
        const secret = secretVariableNames(command);
        expect([...secret].sort()).toEqual(['password', 'query']);
        expect(maskPlaceholders(command, values, secret)).toBe('mysql -u root -p{{password}} -h db-1 -e "{{query}}" # {{password}}');
        expect(maskPlaceholders(command, values, secretVariableNames(command, { marked: ['host', 'unknown'] }))).toBe('mysql -u root -p{{password}} -h {{host}} -e "{{query}}" # {{password}}');
    });

    it('masks secret values of three characters or more in output', () => {
        const secrets = secretValues({ password: 'hunter2-secret', pin: 'ab', token: 'tok' }, new Set(['password', 'pin', 'token']));
        expect(maskSecretValues('pw=hunter2-secret tok tok! ab', secrets)).toBe('pw={{password}} {{token}} {{token}}! ab');
    });

    it('lists the secret values given, longest first', () => {
        expect(secretValues({ a: 'xy', b: '', c: 'longer-value', d: 'kept' }, new Set(['a', 'b', 'c']))).toEqual([
            { name: 'c', value: 'longer-value' },
            { name: 'a', value: 'xy' },
        ]);
    });
});

describe('required values', () => {
    it('lists the variables without default that are still empty', () => {
        const variables = parsePlaceholders('{{a}} {{b:1}} {{c:}} {{d}} {{token}}');
        expect(missingVariables(variables, { d: 'x' })).toEqual(['a', 'token']);
        expect(missingVariables(variables, { a: 'y', d: 'x', token: 't' })).toEqual([]);
        expect(resolveValue(variables[1], {})).toBe('1');
        expect(resolveValue(variables[2], {})).toBe('');
    });
});
