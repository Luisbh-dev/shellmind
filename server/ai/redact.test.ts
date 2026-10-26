import { describe, expect, it } from 'vitest';
import { rewriteAroundPlaceholders } from '../../shared/placeholders';
import { redactArgv, redactClipped, redactHead, redactSecrets, redactTail } from './redact';
import { clipMiddle } from './untrusted';

describe('redactSecrets', () => {
    it.each([
        ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXk='],
        ['token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJhbGciOiJIUzI1NiJ9'],
        ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
        ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
        ['Authorization: Bearer abc.def.ghi-123', 'abc.def.ghi-123'],
        ['postgres://app:s3cr3tP4ss@db:5432/app', 's3cr3tP4ss'],
        ['DB_PASSWORD="hunter2!"', 'hunter2!'],
        ['  password: cGFzc3dvcmQ=', 'cGFzc3dvcmQ='],
        ['GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890abcdefghijklmnopqrstuv']
    ])('masks %s', (text, secret) => {
        const redacted = redactSecrets(text);
        expect(redacted).not.toContain(secret);
        expect(redacted).toContain('[REDACTED]');
    });

    it.each([
        ['redis-server *:6379 --requirepass Hunter2Redis', 'Hunter2Redis'],
        ['ExecStart=/usr/bin/app --password Hunter2Space --token tok_abc123', 'Hunter2Space'],
        ['ExecStart=/usr/bin/app --password Hunter2Space --token tok_abc123', 'tok_abc123'],
        ['app --db-password="two words" --port 80', 'two words'],
        ['vault login --client-secret=s3cr3t-value', 's3cr3t-value'],
        ['keytool -list -storepass changeit2 -keystore x.jks', 'changeit2'],
        ['mysql -u root -pRootPw9988 shop', 'RootPw9988'],
        ['mysqldump -h db -p\'Quoted Pw\' shop', 'Quoted Pw'],
        ['redis-cli -h cache -a RedisPw7766 ping', 'RedisPw7766'],
        ['sshpass -p SshPw5544 ssh admin@db', 'SshPw5544'],
        ['export MYSQL_PWD=plainMysqlPw42', 'plainMysqlPw42'],
        ['REDIS_PASS: redisPass11', 'redisPass11'],
        ['curl -fsS -u admin:S3cretPass https://api.example/health', 'S3cretPass'],
        ['wget --user=admin:WgetPw33 https://x.example/', 'WgetPw33'],
        ['openssl rsa -in k.pem -passin pass:OpensslPw1', 'OpensslPw1']
    ])('masks the credential of %s', (text, secret) => {
        const redacted = redactSecrets(text);
        expect(redacted).not.toContain(secret);
        expect(redacted).toContain('[REDACTED]');
        expect(redactSecrets(redacted)).toBe(redacted);
    });

    it('keeps the options around a masked credential', () => {
        expect(redactSecrets('redis-server --requirepass Hunter2Redis --port 6379')).toBe('redis-server --requirepass [REDACTED] --port 6379');
        expect(redactSecrets('mysql -u root -pRootPw9988 shop')).toBe('mysql -u root -p[REDACTED] shop');
        expect(redactSecrets('curl -u admin:S3cretPass https://x')).toBe('curl -u admin:[REDACTED] https://x');
    });

    it('leaves ordinary output alone', () => {
        const text = [
            'PWD=/home/app',
            'OLDPWD=/root',
            'max_tokens: 4096',
            'nginx.service - A high performance web server',
            'Filesystem Size Used Avail',
            'docker run -u 1000:1000 --password-stdin --password-file /run/secrets/db app',
            'mysql -h db -P 3306 -p shop',
            'app --no-password --host db',
            'sshd[812]: Failed password for root from 203.0.113.9 port 4242 ssh2',
            'compass bypass --tokenizer simple'
        ].join('\n');
        expect(redactSecrets(text)).toBe(text);
    });

    it('masks an option\'s value as one shell word, quoted parts included', () => {
        expect(redactSecrets('app --token "abc"def --verbose')).toBe('app --token [REDACTED] --verbose');
        expect(redactSecrets('mysql -p"abc"def shop')).toBe('mysql -p[REDACTED] shop');
        expect(redactSecrets('app --password=abc"de f" --x')).toBe('app --password=[REDACTED] --x');
    });

    // A multi-exec template is redacted around its placeholders: one where a
    // credential would be is the variable, not a typed secret.
    it('takes no placeholder set aside by rewriteAroundPlaceholders for a credential', () => {
        for (const template of [
            'mysql -u root -p{{pw}} && app --password={{pw}} --token {{t}}; export DB_PASS={{pw}}; openssl x -passin pass:{{pw}}; sshpass -p {{pw}} ssh x',
            'app --password="{{pw}}" --token \'{{t}}\' --api-key={{a}}{{b}} && export DB_PASS="{{pw}}"; app --password={{pw}};ls',
            'sh -c "app --password={{pw}}" && ssh db \'mysql -p{{pw}} shop\'',
            'curl -u {{user}}:{{pw}} -H "Authorization: Bearer {{token}}" https://x; export API_TOKEN={{token}} DB_PASS=\'{{pw}}\', x'
        ]) {
            expect(rewriteAroundPlaceholders(template, redactSecrets)).toBe(template);
        }
        expect(rewriteAroundPlaceholders('app --password=hunter2xyz -n {{n:1}}', redactSecrets)).toBe('app --password=[REDACTED] -n {{n:1}}');
    });

    // What multi-exec records then falls back to masking the text as a whole.
    it.each([
        ['app --password={{env}}hunter2xyz', 'hunter2xyz'],
        ['mysql -u root -p{{env}}Sup3rS3cret', 'Sup3rS3cret'],
        ['mysql -p{{x}}Secret', 'Secret'],
        ['mysql -p"{{x}}"Secret', 'Secret'],
        ['export DB_PASS={{env}}Sup3rS3cret', 'Sup3rS3cret'],
        ['openssl enc -passin pass:{{env}}Sup3rS3cret', 'Sup3rS3cret'],
        ['app --token "{{env}}"hunter2xyz', 'hunter2xyz'],
        ['app --token "{{a}} hunter2xyz"', 'hunter2xyz'],
        ['sh -c "app --password={{a}}hunter2xyz"', 'hunter2xyz'],
        ['export API_TOKEN={{prefix}}abcd1234', 'abcd1234'],
        ['curl -H "Authorization: Bearer {{a}}abcd1234" -u admin:{{b}}Pw1234 x', 'abcd1234'],
        ['curl -u admin:{{b}}Pw1234 x', 'Pw1234']
    ])('takes a secret typed next to a placeholder whole: %s', (template, secret) => {
        expect(rewriteAroundPlaceholders(template, redactSecrets)).toBeNull();
        const masked = redactSecrets(template);
        expect(masked).not.toContain(secret);
        expect(masked).toContain('[REDACTED]');
    });
});

describe('redactArgv', () => {
    it('masks the argument after an option that takes a credential, blanks and all', () => {
        expect(redactArgv(['redis-server', '--requirepass', 'Hunter2 Redis', '--port', '6379'])).toEqual(['redis-server', '--requirepass', '[REDACTED]', '--port', '6379']);
        expect(redactArgv(['app', '--api-key=key with blanks', '--verbose'])).toEqual(['app', '--api-key=[REDACTED]', '--verbose']);
        expect(redactArgv(['app', '--no-password', '--host', 'db'])).toEqual(['app', '--no-password', '--host', 'db']);
        expect(redactArgv(['sh', '-c', 'mysql -pRootPw9988 shop'])).toEqual(['sh', '-c', 'mysql -p[REDACTED] shop']);
    });
});

// SEC-1: text from a server (a log line, container output) must not be able
// to stall the backend. The unbounded patterns took 2 minutes on 16 000
// characters of "token." and grew with the square or cube of the length.
describe('redactSecrets on adversarial text', () => {
    it('masks long runs of look-alike tokens in linear time', () => {
        const inputs = [
            'a.'.repeat(100_000),
            '-a'.repeat(100_000),
            'token.'.repeat(50_000),
            'a-pass.'.repeat(30_000),
            'curl '.repeat(40_000),
            'mysql '.repeat(40_000),
            'sshpass redis-cli '.repeat(10_000),
            'sk-eyJ'.repeat(30_000),
            'x://a:'.repeat(30_000)
        ];
        const started = performance.now();
        for (const text of inputs) redactSecrets(text);
        // Each input took from seconds to hours before; all of them now take
        // a few tens of milliseconds.
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it('still masks prefixed and long names after bounding the patterns', () => {
        for (const [text, secret] of [
            ['DB_PASS=hunter2pw', 'hunter2pw'],
            ['my_api_key: abcd1234efgh', 'abcd1234efgh'],
            ['MYSQL_PWD=plainPw42', 'plainPw42'],
            ['spring.datasource.password=s3cr3tValue', 's3cr3tValue'],
            [`${'A'.repeat(100)}_PASSWORD=longNamePw1`, 'longNamePw1'],
            [`${'a.'.repeat(60)}api_token: tok_123456`, 'tok_123456'],
            ['postgresql+psycopg2://app:dbPw987@db/app', 'dbPw987'],
            ['curl -s -H "Accept: x" -H "X: y" -u admin:CurlPw1 https://x', 'CurlPw1'],
            ['mysql -e "select mysql from t" -pMyPw123', 'MyPw123'],
            ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0']
        ]) {
            expect(redactSecrets(text)).not.toContain(secret);
        }
        expect(redactSecrets('max_tokens: 4096')).toBe('max_tokens: 4096');
        expect(redactSecrets('PWD=/home/app OLDPWD=/root')).toBe('PWD=/home/app OLDPWD=/root');
    });
});

describe('redactClipped', () => {
    it('matches masking the whole text and then clipping it', () => {
        const text = `GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${'line\n'.repeat(3000)}password=tailSecret99`;
        expect(redactClipped(text, 2000)).toEqual(clipMiddle(redactSecrets(text), 2000));
    });

    it('masks only the ends it keeps of a huge text, a secret cut by the margin included', () => {
        const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'QUJDRA=='.repeat(400)}\n-----END RSA PRIVATE KEY-----`;
        const text = `password=headSecret1 ${'a.'.repeat(2_000_000)}\n${pem}\napi_key=tailSecret2`;
        const started = performance.now();
        const clipped = redactClipped(text, 16_000);
        expect(performance.now() - started).toBeLessThan(1500);
        expect(clipped.clipped).toBe(true);
        expect(clipped.text).not.toContain('headSecret1');
        expect(clipped.text).not.toContain('tailSecret2');
        expect(clipped.text).not.toContain('QUJDRA==');
        expect(clipped.text).toContain(`[... ${text.length - 16_000} characters omitted ...]`);
    });

    it('masks the ends taken by redactTail and redactHead', () => {
        const text = `token=abcdef123 ${'x '.repeat(100_000)} secret: zyxwvu987`;
        expect(redactTail(text, 50)).not.toContain('zyxwvu987');
        expect(redactTail(text, 50).length).toBeLessThanOrEqual(50);
        expect(redactHead(text, 50)).toBe('token=[REDACTED] x x x x x x x x x x x x x x x x x');
    });
});
