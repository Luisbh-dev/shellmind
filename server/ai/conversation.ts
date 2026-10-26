import type { ChatAttachment, ChatCommandOutput, ChatEvidence, ChatPurpose, ChatTerminalShell } from "../../shared/chat";
import {
    MAX_COMMAND_OUTPUT_CHARS,
    MAX_CONTEXT_ISSUES,
    MAX_CONTEXT_ISSUE_CHARS,
    MAX_TERMINAL_CONTEXT_CHARS,
    MAX_TERMINAL_CONTEXT_LINES
} from "../../shared/models";
import type { ChatTurn } from "../../shared/types";
import { diagnoseInstruction, evidenceBlocks } from "./diagnose/prompt";
import type { ChatEnvironment } from "./environment";
import { commandOutputBlock, hasUserMessage, sanitizeChatHistory } from "./history";
import { redactHead, redactTail } from "./redact";
import { buildSystemPrompt } from "./systemPrompt";
import { dataBlock, tailText } from "./untrusted";

export const FIX_IT_INSTRUCTION =
    "ShellMind request: give the single safest command that fixes the latest error in the terminal data above. " +
    "Answer with one fenced code block tagged with the shell language, preceded by at most one short sentence. " +
    "If no command can fix it, explain why in one sentence and do not include a code block.";

// Auto-Run keeps going while the answer has a runnable block: a failure is
// fixed with a corrected command, not handed back to the user.
export const AUTORUN_INSTRUCTION =
    "ShellMind request: the commands from your previous answer ran automatically in the terminal; their output is in the command-output block above. " +
    "The code blocks of this answer will run automatically too.\n" +
    "- If the output shows a failure (an error, input that reached the shell mangled or cut off, syntax of another shell), state the cause in one sentence and give the corrected commands in a code block right away. Do not repeat a command unchanged.\n" +
    "- If it worked and the user's task needs more commands, give the next ones in a code block.\n" +
    "- Answer without any code block only when the task is done (then answer the user's request with the actual values from the output), when you need information only the user has (ask for it), or when the next step is destructive or disruptive (explain it and ask for confirmation).\n" +
    "- Never ask the user to type, paste or run commands by hand: your code blocks run by themselves.";

// The terminal did not show a prompt again in time: anything typed now would
// go to the running command (or answer one of its questions).
export const AUTORUN_RUNNING_INSTRUCTION =
    "ShellMind request: the commands from your previous answer were typed into the terminal, but the output in the command-output block above does not end at a shell prompt: " +
    "they may still be running or waiting for input. Report what the output shows so far and what the user should check. " +
    "Do not include any code block and do not suggest new commands in this answer.";

export type ConversationInput = {
    purpose: ChatPurpose;
    // The user's message (purpose "chat"; optional for "diagnose").
    message: string;
    // Purpose "diagnose": what is diagnosed, the evidence collected for it,
    // and the UI language (its headings).
    attachment?: ChatAttachment;
    evidence?: ChatEvidence;
    language?: string;
    history?: unknown;
    environment: ChatEnvironment;
    // Untrusted data captured from the user's systems.
    osDetail?: string;
    terminalOutput?: string;
    issues?: string[];
    commandOutput?: ChatCommandOutput;
    // The focused terminal tab (its output above) is a shell inside a container.
    terminalShell?: ChatTerminalShell;
    // The answer's runnable blocks run by themselves.
    autoRun?: boolean;
    dataId: string;
};

export type Conversation = {
    system: string;
    // Alternating turns, starting and ending with "user".
    turns: ChatTurn[];
};

function dataBlocks(input: ConversationInput): string[] {
    const blocks: string[] = [];
    const osDetail = input.osDetail?.replace(/\s+/g, " ").trim().slice(0, 200);
    if (osDetail) blocks.push(dataBlock("environment", `Detected OS / tool version: ${osDetail}`, input.dataId));

    if (input.purpose === "autorun-step" && input.commandOutput) {
        const { command, output, truncated, stillRunning } = input.commandOutput;
        const notes = [
            truncated ? "(Only the end of the output was captured.)" : "",
            stillRunning ? "(No shell prompt appeared after the output: the command may still be running.)" : ""
        ].filter(Boolean);
        blocks.push([commandOutputBlock(command, output, input.dataId, MAX_COMMAND_OUTPUT_CHARS), ...notes].join("\n"));
        return blocks;
    }

    // A diagnosis rests on its evidence alone: the terminal may show
    // something unrelated.
    if (input.purpose === "diagnose") {
        if (input.evidence) blocks.push(...evidenceBlocks(input.evidence, input.dataId));
        return blocks;
    }

    // Where the terminal output comes from, and where the commands of the
    // answer would go: the chat's Run waits for the user to choose there.
    // W8-T2: a shell inside a Kubernetes pod's container.
    if (input.terminalShell?.kind === "pod") {
        const { context, namespace, pod, container } = input.terminalShell;
        blocks.push(dataBlock(
            "environment",
            `The focused terminal tab is a shell inside the container "${container}" of the Kubernetes pod "${namespace}/${pod}" (kubeconfig context "${context}"), not the server's own shell: the terminal output and errors below come from inside that container. ` +
            "Commands from your answer are not typed into it by themselves: the user chooses whether they run in the server's own shell or inside the container, and Auto-Run does not type there. " +
            "Say which of the two each command is meant for; changes to the pod itself are kubectl commands for the server's own shell.",
            input.dataId
        ));
    } else if (input.terminalShell) {
        const { engine, container } = input.terminalShell;
        blocks.push(dataBlock(
            "environment",
            `The focused terminal tab is a shell inside the ${engine} container "${container}" on this server, not the server's own shell: the terminal output and errors below come from inside that container. ` +
            "Commands from your answer are not typed into it by themselves: the user chooses whether they run in the server's own shell or inside the container, and Auto-Run does not type there. " +
            "Say which of the two each command is meant for.",
            input.dataId
        ));
    }

    const terminal = input.terminalOutput?.trim()
        ? tailText(redactTail(input.terminalOutput, MAX_TERMINAL_CONTEXT_CHARS), MAX_TERMINAL_CONTEXT_LINES, MAX_TERMINAL_CONTEXT_CHARS)
        : "";
    if (terminal.trim()) blocks.push(dataBlock("terminal-output", `Last lines of the terminal:\n${terminal}`, input.dataId));

    const issues = (input.issues ?? [])
        .slice(-MAX_CONTEXT_ISSUES)
        .map((issue) => redactHead(issue, MAX_CONTEXT_ISSUE_CHARS).trim())
        .filter(Boolean);
    if (issues.length) blocks.push(dataBlock("terminal-issues", `Recent errors detected in the terminal:\n${issues.map((issue) => `- ${issue}`).join("\n")}`, input.dataId));
    return blocks;
}

function instructionFor(input: ConversationInput): string {
    if (input.purpose === "fix-it") return FIX_IT_INSTRUCTION;
    if (input.purpose === "autorun-step") return input.commandOutput?.stillRunning ? AUTORUN_RUNNING_INSTRUCTION : AUTORUN_INSTRUCTION;
    if (input.purpose === "diagnose" && input.attachment) {
        const instruction = diagnoseInstruction(input.attachment, input.language, input.evidence, {
            earlierUserMessage: hasUserMessage(input.history),
            userMessage: Boolean(input.message)
        });
        return input.message ? `${instruction}\n\nUser message:\n${input.message}` : instruction;
    }
    return input.message;
}

export function buildFinalUserTurn(input: ConversationInput): string {
    const blocks = dataBlocks(input);
    const instruction = instructionFor(input);
    if (!blocks.length) return instruction;
    const label = input.purpose === "chat" ? "User message:\n" : "";
    return `${blocks.join("\n\n")}\n\n${label}${instruction}`;
}

export function buildConversation(input: ConversationInput): Conversation {
    const turns = sanitizeChatHistory(input.history, input.dataId);
    const finalTurn = buildFinalUserTurn(input);
    const last = turns[turns.length - 1];
    if (last && last.role === "user") last.content += `\n\n${finalTurn}`;
    else turns.push({ role: "user", content: finalTurn });

    // A Fix it command and the fix of a diagnosis wait for the user's click,
    // also with Auto-Run on.
    const autoRun = input.autoRun === true && input.purpose !== "fix-it" && input.purpose !== "diagnose";
    return { system: buildSystemPrompt(input.environment, input.dataId, { autoRun }), turns };
}
