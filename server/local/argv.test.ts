import { describe, expect, it } from 'vitest';
import { CommandLineError, parseCommandLine } from './argv';

const posix = (input: string) => parseCommandLine(input, { windows: false });
const windows = (input: string) => parseCommandLine(input, { windows: true });

describe('parseCommandLine', () => {
    it.each<[string, string[]]>([
        ['ps -a', ['ps', '-a']],
        ['  get   pods  ', ['get', 'pods']],
        ['run -e "A=b c" img', ['run', '-e', 'A=b c', 'img']],
        ["get pods -o jsonpath='{.items[*].metadata.name}'", ['get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}']],
        ['vm list --query "[?name==\'web\']"', ['vm', 'list', '--query', "[?name=='web']"]],
        ['a""b \'\'', ['ab', '']],
        ['say "a \\"quoted\\" word"', ['say', 'a "quoted" word']],
        ['path\\ with\\ spaces', ['path with spaces']],
        ['"keep \\n as is"', ['keep \\n as is']],
        ['', []],
    ])('POSIX: %j -> %j', (input, argv) => {
        expect(posix(input)).toEqual({ argv, operator: null });
    });

    it.each<[string, string[]]>([
        ['"C:\\Program Files\\Git\\bin\\bash.exe" --login', ['C:\\Program Files\\Git\\bin\\bash.exe', '--login']],
        ['wsl -d "Ubuntu 22.04"', ['wsl', '-d', 'Ubuntu 22.04']],
        ['C:\\tools\\x.exe C:\\temp\\', ['C:\\tools\\x.exe', 'C:\\temp\\']],
        ['"C:\\dir\\\\" next', ['C:\\dir\\', 'next']],
        ['say \\"hi\\"', ['say', '"hi"']],
        ['"a ""quoted"" b"', ['a "quoted" b']],
        ["--query '[?a==`1`]'", ['--query', '[?a==`1`]']],
    ])('Windows: %j -> %j', (input, argv) => {
        expect(windows(input)).toEqual({ argv, operator: null });
    });

    it.each<[string, string]>([
        ['ps | grep web', '|'],
        ['ps || calc', '||'],
        ['ps & calc', '&'],
        ['ps && calc', '&&'],
        ['ps; rm -rf ~', ';'],
        ['logs > out.txt', '>'],
        ['logs >> out.txt', '>>'],
        ['run < in.txt', '<'],
        ['echo $(id)', '$('],
        ['echo `id`', '`'],
        ['ps\nimages', 'newline'],
    ])('reports the unquoted operator in %j', (input, operator) => {
        expect(posix(input).operator).toBe(operator);
        expect(windows(input).operator).toBe(operator);
    });

    it('keeps quoted operators as plain characters', () => {
        expect(posix('exec web sh -c "ps | grep x; id"')).toEqual({ argv: ['exec', 'web', 'sh', '-c', 'ps | grep x; id'], operator: null });
        expect(windows('ps --format "{{.Names}} & {{.ID}}"')).toEqual({ argv: ['ps', '--format', '{{.Names}} & {{.ID}}'], operator: null });
        expect(posix("echo '$(id)' \\|")).toEqual({ argv: ['echo', '$(id)', '|'], operator: null });
    });

    it('rejects unterminated quotes', () => {
        expect(() => posix('say "hi')).toThrow(CommandLineError);
        expect(() => windows("it's")).toThrow('Unterminated single quote.');
    });
});
