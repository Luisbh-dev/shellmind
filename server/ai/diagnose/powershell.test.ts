import { describe, expect, it } from 'vitest';
import { isValidLogPath } from '../../../shared/ops';
import { runLocalPowerShell } from '../../../test/helpers/localPowerShell';
import { PROCESS_TEST_TIMEOUT_MS } from '../../../test/setup/timeouts';
import { compactPowerShell, psQuote } from '../../ops/remote';
import { checkLogSource, windowsTailScript } from './logs';
import { windowsServiceEventsScript } from './service';

// Text that would break out of a PowerShell string: ASCII and typographic
// single quotes (PowerShell ends a single-quoted string at U+2018-U+201B
// too), double quotes, `$(...)`, backticks and a newline.
const PAYLOADS = [
    "Fake Service\u2019;Write-Output INJECTED;$x=\u2019",
    "C:\\a\u2019 -Tail 1}catch{};Write-Output INJECTED;try{Get-Content -LiteralPath \u2019C:\\b",
    "it's \u2018quoted\u2019 \u201alow\u201b \"double\" $(Write-Output INJECTED) `n end",
    "line\n';Write-Output INJECTED;'"
];

describe('Windows log paths', () => {
    it('refuse the quotes PowerShell knows, typographic ones included', () => {
        expect(isValidLogPath('windows', 'C:\\logs\\app.log')).toBe(true);
        for (const quote of ["'", '"', '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e']) {
            expect(isValidLogPath('windows', `C:\\logs\\a${quote}b.log`)).toBe(false);
        }
        expect(() => checkLogSource('windows', { kind: 'file', path: PAYLOADS[1] })).toThrow(/absolute path/);
    });
});

// Reads PowerShell source with PowerShell's own parser, without running it
// (the payloads above never reach a running pipeline): for each source, the
// parse errors, the commands it would run, and the value of the expressions
// that `value` scripts name (a psQuote string or the right side of $n=, $d=
// and -LiteralPath), folded from constants, [char] codes and + only.
const CHECKER = `
function V($x){
if($x -is [Management.Automation.Language.StringConstantExpressionAst]){return [string]$x.Value}
if($x -is [Management.Automation.Language.ParenExpressionAst] -and $x.Pipeline.PipelineElements.Count -eq 1){return V $x.Pipeline.PipelineElements[0].Expression}
if($x -is [Management.Automation.Language.BinaryExpressionAst] -and $x.Operator -eq 'Plus'){return (V $x.Left)+(V $x.Right)}
if($x -is [Management.Automation.Language.ConvertExpressionAst] -and $x.Type.TypeName.Name -eq 'char' -and $x.Child -is [Management.Automation.Language.ConstantExpressionAst]){return [string][char][int]$x.Child.Value}
throw ('not a constant: '+$x.GetType().Name)
}
$out=@()
foreach($s in $sources){
$t=$null;$e=$null
$a=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)
$c=@($a.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)|%{[string]$_.GetCommandName()})
$v=@()
foreach($n in $a.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.VariablePath.UserPath -in 'n','d','p'},$true)){$v+=V $n.Right.Expression}
foreach($n in $a.FindAll({param($n) $n -is [Management.Automation.Language.CommandParameterAst] -and $n.ParameterName -eq 'LiteralPath'},$true)){$p=$n.Parent.CommandElements[$n.Parent.CommandElements.IndexOf($n)+1];$v+=V $p}
$out+=[pscustomobject]@{errors=$e.Count;commands=$c;values=$v}
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`;

type Parsed = { errors: number; commands: string[]; values: string[] };

async function parse(sources: string[], skip: Parameters<typeof runLocalPowerShell>[1]): Promise<Parsed[]> {
    const script = `$sources=@(${sources.map(psQuote).join(',')})\n${CHECKER}`;
    const { stdout, code } = await runLocalPowerShell(script, skip);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as Parsed[];
    expect(parsed).toHaveLength(sources.length);
    return parsed.map((entry) => ({ ...entry, commands: [entry.commands].flat(), values: [entry.values].flat() }));
}

// The PowerShell of this machine (Windows only).
describe.runIf(process.platform === 'win32')('Windows PowerShell', () => {
    it('reads psQuote back as the exact text, one constant expression', async ({ skip }) => {
        const parsed = await parse(PAYLOADS.map((payload) => `$p=${psQuote(payload)}`), skip);
        expect(parsed.map((entry) => entry.values)).toEqual(PAYLOADS.map((payload) => [payload]));
        for (const entry of parsed) expect(entry).toMatchObject({ errors: 0, commands: [] });
    }, PROCESS_TEST_TIMEOUT_MS);

    it('parses the evidence scripts with the names they embed as data', async ({ skip }) => {
        const parsed = await parse([
            ...PAYLOADS.map((payload) => windowsServiceEventsScript('Spooler', payload)),
            ...PAYLOADS.map((payload) => windowsTailScript(payload, 200))
        ].map(compactPowerShell), skip);
        PAYLOADS.forEach((payload, index) => {
            // The display name is kept to one line.
            expect(parsed[index].values).toEqual(['Spooler', payload.replace(/\n/g, ' ')]);
            expect(parsed[PAYLOADS.length + index].values).toEqual([payload]);
        });
        for (const entry of parsed) {
            expect(entry.errors).toBe(0);
            expect(entry.commands).not.toContain('Write-Output');
        }
    }, PROCESS_TEST_TIMEOUT_MS);

    it('tails a path with accents and typographic quotes as it is written', async ({ skip }) => {
        const path = 'C:\\ShellMind-no-such-folder\\caf\u00e9 \u2019quoted\u2019 [1].log';
        const { stdout, code } = await runLocalPowerShell(windowsTailScript(path, 5), skip);
        expect(code).toBe(1);
        // "An object at the specified path ... does not exist" (in the language of the system).
        expect(stdout).toContain(path);
    }, PROCESS_TEST_TIMEOUT_MS);
});
