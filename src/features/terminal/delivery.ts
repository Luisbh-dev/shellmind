import { encodePowerShellBlock } from '@shared/powershell';
import { cursorPromptShell, programName, scopedPresetKey, shellOfProgram } from '@shared/shells';
import { trimTrailingNewlines } from '@shared/text';
import type { ServerSummary } from '@shared/types';

// How a command sent by the app (AI chat, Auto-Run, snippets, history) is
// typed into a terminal. A single line goes as typed. A multi-line block
// typed one line at a time breaks in some shells: Windows PowerShell 5.1
// rejects a line that starts with "|", and PSReadLine mixes the lines typed
// ahead with the output of the one running. So a block is delivered by the
// shell that reads input now (sessionShell()):
//   powershell       as one line that decodes the block and runs it in the
//                    current scope, statement by statement: cd and variables
//                    persist, and each statement's output is formatted on its
//                    own, as if it had been typed (shared/powershell.ts).
//   bracketed-paste  a shell that turned bracketed paste on (bash, zsh) gets
//                    the block as one paste, so heredocs and indentation
//                    arrive intact, and runs it with one Enter.
//   lines            anything else (cmd.exe, scoped CLI consoles, the FTP
//                    shell, shells without bracketed paste): one Enter per line.

export type SessionShell = 'powershell' | 'cmd' | 'posix' | 'console' | 'unknown';
export type Delivery = 'single-line' | 'powershell' | 'bracketed-paste' | 'lines';

export type ShellServer = Pick<ServerSummary, 'type' | 'cli_preset' | 'command' | 'os_detail'> & { osDetail?: string };

// The shell a server's terminal starts (see server/sockets/terminal.ts, and
// server/local/pty.ts for the local consoles).
export function configuredShell(server: ShellServer): SessionShell {
    switch (server.type) {
        case 'linux': return 'posix';
        // OpenSSH on Windows starts cmd.exe unless DefaultShell says otherwise.
        case 'windows': return 'cmd';
        case 'ftp':
        case 's3': return 'console';
        case 'local': break;
        default: return 'unknown';
    }
    if (scopedPresetKey(server.cli_preset)) return 'console';
    if (server.command?.trim()) return shellOfProgram(programName(server.command)) ?? 'unknown';
    // The default local shell: PowerShell on Windows, the login shell
    // elsewhere. The detected OS tells which (it is the backend's).
    const os = `${server.osDetail ?? ''} ${server.os_detail ?? ''}`;
    if (/windows/i.test(os)) return 'powershell';
    return os.trim() ? 'posix' : 'unknown';
}

// The shell whose prompt starts `line` (the line the cursor is on, up to the
// cursor): "$ ", "/ # ", "bash-5.2$ " too (a shell started in a container
// or from another shell). See shared/shells.ts.
export function promptShell(line: string): SessionShell | null {
    return cursorPromptShell(line);
}

// The shell that reads input now: the prompt the cursor is on tells (the user
// may have started another shell), otherwise the configured one. With no
// prompt in sight, bracketed paste on in a PowerShell or cmd session means
// a shell started from it reads input (Windows PowerShell 5.1 and cmd never
// turn it on). App consoles (scoped CLIs, FTP) never run another shell.
export function sessionShell(server: ShellServer, cursorLine: string, bracketedPaste: boolean): SessionShell {
    const configured = configuredShell(server);
    if (configured === 'console') return configured;
    const prompt = promptShell(cursorLine);
    if (prompt) return prompt;
    if (bracketedPaste && (configured === 'powershell' || configured === 'cmd')) return 'unknown';
    return configured;
}

const normalize = (command: string) => trimTrailingNewlines(command.replace(/\r\n?/g, '\n'));

export type TerminalScreenState = {
    // A full-screen program (vi, less, top) holds the terminal.
    alternateScreen: boolean;
    bracketedPaste: boolean;
    // The line the cursor is on, up to the cursor.
    cursorLine: string;
};

export type TypingRisk = 'full-screen' | 'no-prompt';

// Why typing a command the user did not type here (AI chat, snippets,
// history) could go wrong now, or null when a shell is reading:
//   full-screen  the keys would go to vi, less, top..., not to the shell
//   no-prompt    a block of lines for a terminal that shows no shell prompt
//                (mysql>, a "Proceed? [y/N]" question...). A line editor
//                that turned bracketed paste on gets the block as one paste.
// A session that just connected shows no prompt yet: wait for the shell
// first (shellReady.ts).
export function typingRisk(command: string, server: ShellServer, screen: TerminalScreenState): TypingRisk | null {
    if (screen.alternateScreen) return 'full-screen';
    if (!normalize(command).includes('\n') || screen.bracketedPaste) return null;
    if (configuredShell(server) === 'console') return null;
    return promptShell(screen.cursorLine) === null ? 'no-prompt' : null;
}

export function lineCount(command: string): number {
    return normalize(command).split('\n').length;
}

export function deliveryFor(command: string, shell: SessionShell, bracketedPaste: boolean): Delivery {
    if (!normalize(command).includes('\n')) return 'single-line';
    if (shell === 'powershell') return 'powershell';
    if (bracketedPaste && (shell === 'posix' || shell === 'unknown')) return 'bracketed-paste';
    return 'lines';
}

/* eslint-disable no-control-regex -- terminal escape sequences */
const PASTE_END = /\x1b\[201~/g;
/* eslint-enable no-control-regex */

// What is written to the terminal for `command`; it ends with the Enter that
// runs it.
export function terminalInput(command: string, delivery: Delivery): string {
    const text = normalize(command);
    switch (delivery) {
        case 'powershell': return `${encodePowerShellBlock(text)}\r`;
        // Line breaks inside a paste are carriage returns, as a terminal pastes them.
        case 'bracketed-paste': return `\x1b[200~${text.replace(PASTE_END, '').replace(/\n/g, '\r')}\x1b[201~\r`;
        default: return `${text.replace(/\n/g, '\r')}\r`;
    }
}
