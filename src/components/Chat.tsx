"use client";

import { useEffect, useRef, useState } from "react";
import {
    Send, Bot, Sparkles, Play, Zap, Terminal, AlertTriangle, Star, X, Square,
    Copy, RefreshCw, Check, User, Trash2
} from "lucide-react";
import { cn } from "@/lib/cn";
import ReactMarkdown from "react-markdown";
import { useToast } from "@/components/ui/Toast";
import { type ConnState, Select, useConfirm } from "@/components/ui";
import { API_BASE } from "@/config";

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
}

interface TerminalIssue {
    id: string;
    type: "error" | "warning";
    message: string;
    details?: string;
    timestamp: number;
}

interface ChatProps {
    activeServer: any;
    connectionState?: ConnState;
    terminalHistory?: React.MutableRefObject<string>;
    terminalIssues?: TerminalIssue[];
    onDismissTerminalIssue?: (issueId: string) => void;
    onClearTerminalIssues?: () => void;
}

const greetingFor = (server: any, state?: ConnState) => {
    if (!server) return "ShellMind AI ready. Select a server to begin.";
    const name = `**${server.name}**`;
    if (server.type === "s3") return `Browsing ${name}. AI chat is disabled for object storage.`;
    switch (state) {
        case "connected": return `Connected to ${name}. Ready to assist.`;
        case "error": return `Couldn't connect to ${name}. I can still help — see the issue below or ask me anything.`;
        case "disconnected": return `Session to ${name} ended. Reconnect from the terminal, or ask me anything.`;
        default: return `Connecting to ${name}…`;
    }
};

const CLI_PRESET_LABELS: Record<string, string> = {
    azure: "Azure CLI (az)",
    aws: "AWS CLI (aws)",
    gcloud: "Google Cloud CLI (gcloud)",
    kubectl: "kubectl",
    docker: "Docker CLI",
    shell: "the system shell",
    custom: "a custom local command"
};

// Binary behind each scoped preset (the "<bin>>" prompt of the console).
const CLI_PRESET_BINS: Record<string, string> = {
    azure: "az",
    aws: "aws",
    gcloud: "gcloud",
    kubectl: "kubectl",
    docker: "docker"
};

const getScopedBin = (server: any): string | null =>
    server?.type === "local" ? CLI_PRESET_BINS[server.cli_preset] || null : null;

// Human/AI-readable description of the active connection, used as chat context.
const describeServer = (server: any) => {
    if (!server) return "No active server connection.";
    if (server.type === "local") {
        const preset = server.cli_preset || "shell";
        const focus = CLI_PRESET_LABELS[preset] || "the local shell";
        const bin = getScopedBin(server);
        const detected = server.osDetail ? ` Detected environment: ${server.osDetail}.` : "";
        if (bin) {
            return `This is a LOCAL, SCOPED ${focus} console on the user's own machine: it only runs ${bin} subcommands (a "${bin}>" prompt), not a full shell. ` +
                `CRITICAL COMMAND FORMAT: in code blocks, output ONLY the subcommand with its arguments — WITHOUT the leading "${bin}" and WITHOUT the "${bin}>" prompt. ` +
                `Correct: \`ps -a\`. Incorrect: \`${bin} ps -a\` or \`${bin}> ps\`. ` +
                `Pipes, redirections and other programs are NOT available in this console. ` +
                `Assume the tool is installed and authenticated locally.${detected} The terminal output below is from this console (the "${bin}>" you see there is the prompt, never part of a command).`;
        }
        return `This is a LOCAL shell session named "${server.name}" on the user's own machine (PowerShell on Windows, bash/zsh on macOS/Linux). Provide shell-appropriate commands and assume local tools are installed.${detected} The terminal output below comes from this shell.`;
    }
    return `Connected to ${server.name} (${server.osDetail || server.type} - ${server.ip})`;
};

const MODEL_OPTIONS = [
    { value: "MiniMax-M2.7", label: "MiniMax M2.7" },
    { value: "MiniMax-M3", label: "MiniMax M3" },
    { value: "gemini-2.5-flash", label: "Flash 2.5 (Smart)" },
    { value: "gemini-3-flash-preview", label: "Flash 3 (Smartest)" },
    { value: "gemma-3-27b-it", label: "Gemma 3 (Standard)" }
] as const;
const HIDDEN_MODEL_LABELS: Record<string, string> = {
    "MiniMax-M2.7-highspeed": "MiniMax M2.7 Highspeed"
};

// UI-only notices (greetings, OS banners, fallback warnings) that must not
// reach the AI as conversation history.
const SYNTHETIC_MESSAGE_ID_PREFIXES = ["init-", "os-info-", "sys-switch-", "autorun-cap-"];
const isSyntheticMessage = (msg: Message) =>
    msg.id === "1" || SYNTHETIC_MESSAGE_ID_PREFIXES.some(prefix => msg.id.startsWith(prefix));

const MAX_HISTORY_MESSAGES = 12;

// Prior conversation turns (excluding the message being sent) for the AI.
const buildChatHistory = (priorMessages: Message[]) =>
    priorMessages
        .filter(msg => !isSyntheticMessage(msg))
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({ role: msg.role, content: msg.content }));

const DIAGNOSTIC_PROMPT = "Analyze the latest SSH terminal failure and give me the exact command to fix it.";

const formatIssueEntry = (entry: TerminalIssue) => {
    const stamp = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
    const details = entry.details ? `\n  details: ${entry.details}` : "";
    return `- [${stamp}] ${entry.type.toUpperCase()}: ${entry.message}${details}`;
};

const extractCommandFromResponse = (text: string) => {
    const codeBlock = text.match(/```(?:[\w-]+)?\s*([\s\S]*?)```/);
    if (codeBlock?.[1]) {
        return codeBlock[1].trim();
    }

    const cleaned = text
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .find(line => !line.startsWith("```"));

    return cleaned?.replace(/^[-*]\s*/, "").trim() || "";
};

function CodeBlock({ code, onRun }: { code: string; onRun: (code: string) => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code.trim());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch { /* ignore */ }
    };
    return (
        <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-ink-900">
            <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                    <Terminal className="h-3 w-3" /> shell
                </span>
                <div className="flex items-center gap-1">
                    <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition">
                        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        {copied ? "Copied" : "Copy"}
                    </button>
                    <button onClick={() => onRun(code)} className="flex items-center gap-1 rounded bg-brand-500/15 px-1.5 py-0.5 text-[11px] font-medium text-brand-300 hover:bg-brand-500/25 transition">
                        <Play className="h-3 w-3" /> Run
                    </button>
                </div>
            </div>
            <pre className="overflow-x-auto p-2.5 text-xs font-mono leading-relaxed text-zinc-200 whitespace-pre-wrap scrollbar-thin">
                {code.trim()}
            </pre>
        </div>
    );
}

export default function Chat({
    activeServer,
    connectionState,
    terminalHistory,
    terminalIssues,
    onDismissTerminalIssue,
    onClearTerminalIssues
}: ChatProps) {
    const [messages, setMessages] = useState<Message[]>([
        { id: "1", role: "assistant", content: "ShellMind AI ready. Select a server to begin." }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isAutoRun, setIsAutoRun] = useState(false);
    const [selectedModel, setSelectedModel] = useState<string>(MODEL_OPTIONS[0].value);
    const [fixItLoading, setFixItLoading] = useState(false);
    const [fixItSuggestion, setFixItSuggestion] = useState("");
    const [autoRunConfirmOpen, setAutoRunConfirmOpen] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const pendingFixItRequestRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const autoRunTimerRef = useRef<number | null>(null);
    const autoRunStepsRef = useRef(0);
    const toast = useToast();
    const confirmDialog = useConfirm();

    const AUTO_RUN_MAX_STEPS = 5;

    // Clear any pending auto-run timer / abort in-flight request on unmount.
    useEffect(() => {
        return () => {
            if (autoRunTimerRef.current) window.clearTimeout(autoRunTimerRef.current);
            abortRef.current?.abort();
        };
    }, []);

    const latestIssue = terminalIssues?.[terminalIssues.length - 1] || null;
    const recentIssues = terminalIssues?.slice(-3).reverse() || [];
    const getModelLabel = (modelName: string) => MODEL_OPTIONS.find(option => option.value === modelName)?.label || HIDDEN_MODEL_LABELS[modelName] || modelName;
    const normalizeSelectableModel = (modelName: string) => modelName === "MiniMax-M2.7-highspeed" ? "MiniMax-M2.7" : modelName;
    const isRecommendedModelSelected = normalizeSelectableModel(selectedModel) === "MiniMax-M2.7";

    const diagnosticPromptValue = latestIssue
        ? `${DIAGNOSTIC_PROMPT}\n\nRecent terminal issues:\n${terminalIssues?.slice(-8).map(formatIssueEntry).join("\n")}\n\nActive server: ${activeServer ? `${activeServer.name} (${activeServer.osDetail || activeServer.type})` : "None"}`
        : (activeServer
            ? `${DIAGNOSTIC_PROMPT}\n\nActive server: ${activeServer.name} (${activeServer.osDetail || activeServer.type})`
            : DIAGNOSTIC_PROMPT);

    useEffect(() => {
        fetch(`${API_BASE}/api/config/model`)
            .then(res => res.json())
            .then(data => {
                if (data.model) setSelectedModel(normalizeSelectableModel(data.model));
            })
            .catch(err => console.error("Failed to load model config", err));
    }, []);

    const handleModelChange = async (newModel: string) => {
        setSelectedModel(newModel);
        try {
            await fetch(`${API_BASE}/api/config/model`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: newModel })
            });
        } catch (e) {
            console.error("Failed to save model preference", e);
        }
    };

    const toggleAutoRun = () => {
        if (!isAutoRun) {
            setAutoRunConfirmOpen(true);
        } else {
            setIsAutoRun(false);
        }
    };

    const confirmEnableAutoRun = () => {
        setIsAutoRun(true);
        setAutoRunConfirmOpen(false);
    };

    const cancelEnableAutoRun = () => {
        setAutoRunConfirmOpen(false);
    };

    const initMessageId = "init-" + (activeServer?.id || "default");

    useEffect(() => {
        // Abort any in-flight generation from the previous server so its
        // response can't land in the new conversation.
        abortRef.current?.abort();
        setIsLoading(false);

        setMessages([
            {
                id: initMessageId,
                role: "assistant",
                content: greetingFor(activeServer, connectionState)
            }
        ]);
        setFixItSuggestion("");

        // Restore the saved conversation for this server (if any).
        const serverId = activeServer?.id;
        if (serverId == null) return;

        let cancelled = false;
        fetch(`${API_BASE}/api/chat/history/${serverId}`)
            .then(res => res.json())
            .then(data => {
                if (cancelled || !Array.isArray(data?.messages) || data.messages.length === 0) return;
                const restored: Message[] = data.messages
                    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
                    .map((m: any, i: number) => ({ id: `hist-${serverId}-${i}`, role: m.role, content: m.content }));
                if (!restored.length) return;
                setMessages(prev => [...prev.filter(m => m.id === initMessageId), ...restored]);
            })
            .catch(() => { /* offline backend: start fresh */ });

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeServer?.id]);

    // Persist the real conversation (greetings/notices excluded) per server.
    const persistTimerRef = useRef<number | null>(null);
    useEffect(() => {
        const serverId = activeServer?.id;
        if (serverId == null) return;

        const real = messages.filter(m => !isSyntheticMessage(m));
        // An empty list here usually means "freshly reset", not "user cleared
        // it" — explicit clearing goes through the DELETE endpoint instead.
        if (real.length === 0) return;

        if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = window.setTimeout(() => {
            fetch(`${API_BASE}/api/chat/history/${serverId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: real.map(({ role, content }) => ({ role, content })) })
            }).catch(() => { /* best-effort */ });
        }, 600);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, activeServer?.id]);

    const clearConversation = async () => {
        const ok = await confirmDialog({
            title: "Clear conversation",
            message: "Delete the saved chat history for this server? The AI will lose this conversation's context.",
            confirmLabel: "Clear",
            tone: "danger"
        });
        if (!ok) return;

        stopGeneration();
        setMessages([{ id: initMessageId, role: "assistant", content: greetingFor(activeServer, connectionState) }]);
        setFixItSuggestion("");

        if (activeServer?.id != null) {
            fetch(`${API_BASE}/api/chat/history/${activeServer.id}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
        }
    };

    // Keep the greeting in sync with the real connection state (without
    // touching any messages the user has already exchanged).
    useEffect(() => {
        setMessages(prev => prev.map(m =>
            m.id === initMessageId ? { ...m, content: greetingFor(activeServer, connectionState) } : m
        ));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionState]);

    useEffect(() => {
        if (activeServer?.osDetail) {
            setMessages(prev => {
                if (prev.some(m => m.content.includes(activeServer.osDetail))) return prev;

                const isLocal = activeServer.type === "local";
                return [
                    ...prev,
                    {
                        id: "os-info-" + Date.now(),
                        role: "assistant",
                        content: isLocal
                            ? `Environment: **${activeServer.osDetail}**.`
                            : `OS detected: **${activeServer.osDetail}**.\nI will tailor my commands for this system.`
                    }
                ];
            });
        }
    }, [activeServer?.osDetail]);

    const scrollToBottom = () => {
        if (messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        const handleTerminalChatPrompt = (event: Event) => {
            const detail = (event as CustomEvent<{ prompt?: string }>).detail;
            if (!detail?.prompt) return;

            setInput(detail.prompt);
            window.requestAnimationFrame(() => inputRef.current?.focus());
        };

        window.addEventListener("terminal-chat-prompt", handleTerminalChatPrompt as EventListener);
        return () => {
            window.removeEventListener("terminal-chat-prompt", handleTerminalChatPrompt as EventListener);
        };
    }, []);

    const runCommand = (cmd: string) => {
        const scopedBin = getScopedBin(activeServer);

        const lines = cmd.split("\n")
            .map(line => {
                // Strip prompt artifacts the AI may copy from terminal output:
                // "$ cmd" in shells, "docker> ps" in scoped consoles.
                let clean = line.trim().replace(/^\$\s+/, "");
                if (scopedBin) {
                    clean = clean.replace(new RegExp(`^(?:${scopedBin}>\\s*)+`, "i"), "").trim();
                }
                return clean;
            })
            .filter(line => line && !line.startsWith("#"));

        let cleanCmd = "";
        let needsSeparator = false;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let isContinuation = false;

            if (line.endsWith("\\")) {
                line = line.slice(0, -1).trim();
                isContinuation = true;
            }

            if (line.endsWith("&&") || line.endsWith("||") || line.endsWith(";")) {
                isContinuation = true;
            }

            if (i === 0) {
                cleanCmd = line;
            } else {
                // Separate commands run on their own line (Enter); continuations
                // (trailing \, &&, ||, ;) stay on the same logical line.
                cleanCmd += needsSeparator ? `\n${line}` : ` ${line}`;
            }

            needsSeparator = !isContinuation;
        }

        window.dispatchEvent(new CustomEvent("run-terminal-command", { detail: cleanCmd }));
    };

    const copyMessage = async (msg: Message) => {
        try {
            await navigator.clipboard.writeText(msg.content);
            setCopiedId(msg.id);
            window.setTimeout(() => setCopiedId((id) => (id === msg.id ? null : id)), 1400);
        } catch {
            toast.error("Copy failed");
        }
    };

    const renderMessage = (content: string) => {
        const parts = content.split(/(```[\s\S]*?```)/g);
        return parts.map((part, i) => {
            if (part.startsWith("```")) {
                const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
                const code = match ? match[2] : part.slice(3, -3);
                return <CodeBlock key={i} code={code} onRun={runCommand} />;
            }
            if (!part.trim()) return null;
            return (
                <div key={i} className="prose-chat min-w-0 max-w-none break-words text-[13px] leading-relaxed text-zinc-300">
                    <ReactMarkdown>{part}</ReactMarkdown>
                </div>
            );
        });
    };

    const stopGeneration = () => {
        if (autoRunTimerRef.current) {
            window.clearTimeout(autoRunTimerRef.current);
            autoRunTimerRef.current = null;
        }
        abortRef.current?.abort();
        abortRef.current = null;
        setIsLoading(false);
        setFixItLoading(false);
    };

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input,
        };

        const next = [...messages, userMessage];
        setMessages(next);
        setInput("");
        setIsLoading(true);
        autoRunStepsRef.current = 0; // manual message resets the auto-run budget

        await processAiInteraction(next);
    };

    const regenerate = () => {
        if (isLoading) return;
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
        if (lastUserIdx === -1) return;
        const history = messages.slice(0, lastUserIdx + 1);
        setMessages(history);
        setIsLoading(true);
        autoRunStepsRef.current = 0;
        void processAiInteraction(history);
    };

    // Last 50 real lines (capped) so the context matches the label the model sees.
    const buildTerminalContext = () => {
        const raw = terminalHistory?.current;
        if (!raw?.trim()) return "";
        const lastLines = raw.split("\n").slice(-50).join("\n").slice(-6000);
        return `\n\n[LAST 50 LINES OF TERMINAL OUTPUT]\n${lastLines}`;
    };

    const requestFixIt = async () => {
        if (!latestIssue) return;

        const requestId = Date.now();
        pendingFixItRequestRef.current = requestId;
        setFixItLoading(true);
        setFixItSuggestion("");

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const historyContext = buildTerminalContext();

            const issueContext = terminalIssues?.length
                ? `\n\n[RECENT SSH FAILURES]\n${terminalIssues.slice(-8).map(formatIssueEntry).join("\n")}`
                : "";

            const context = describeServer(activeServer) + historyContext + issueContext;

            const res = await fetch(`${API_BASE}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    message: "Return only the exact command that fixes this SSH error. If there are multiple commands, choose the safest single command first. No explanation, no bullets, only the command or a code block.",
                    context,
                    model: selectedModel,
                    history: buildChatHistory(messages)
                })
            });

            const data = await res.json();
            const command = extractCommandFromResponse(data.response || "");

            if (pendingFixItRequestRef.current !== requestId) return;
            setFixItSuggestion(command || (data.response || "").trim());
        } catch (err: any) {
            if (err?.name === "AbortError") return;
            if (pendingFixItRequestRef.current === requestId) {
                setFixItSuggestion("");
            }
        } finally {
            if (pendingFixItRequestRef.current === requestId) {
                setFixItLoading(false);
            }
        }
    };

    const processAiInteraction = async (conversationHistory: Message[], hiddenSystemContext?: string) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const assistantId = "ai-" + Date.now();
        const upsertAssistant = (content: string) => {
            setMessages(prev => prev.some(m => m.id === assistantId)
                ? prev.map(m => (m.id === assistantId ? { ...m, content } : m))
                : [...prev, { id: assistantId, role: "assistant" as const, content }]);
        };

        const warnModelSwitch = (usedModel: string) => {
            const normalizedUsedModel = normalizeSelectableModel(usedModel);
            if (normalizedUsedModel !== selectedModel) {
                setSelectedModel(normalizedUsedModel);
            }
            setMessages(prev => [...prev, {
                id: "sys-switch-" + Date.now(),
                role: "assistant",
                content: `WARNING: Automatically switched to **${getModelLabel(usedModel)}** due to provider limits.`
            }]);
        };

        try {
            const historyContext = buildTerminalContext();

            const terminalIssueContext = terminalIssues?.length
                ? `\n\n[RECENT SSH FAILURES]\n${terminalIssues.slice(-8).map(formatIssueEntry).join("\n")}`
                : "";

            const context = describeServer(activeServer) + historyContext + terminalIssueContext + (hiddenSystemContext ? `\n\n[SYSTEM UPDATE]: ${hiddenSystemContext}` : "");

            const lastMsg = conversationHistory[conversationHistory.length - 1];

            const res = await fetch(`${API_BASE}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    message: lastMsg.content,
                    context: context,
                    model: selectedModel,
                    history: buildChatHistory(conversationHistory.slice(0, -1)),
                    stream: true
                }),
            });

            let responseContent = "";
            const contentType = res.headers.get("content-type") || "";

            if (contentType.includes("text/event-stream") && res.body) {
                // SSE: render deltas live; "done" carries the canonical full text.
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let accumulated = "";
                let finalText: string | null = null;
                let firstModel: string | null = null;
                let streamError: string | null = null;

                const handleEvent = (event: any) => {
                    if (event?.type === "delta" && event.text) {
                        accumulated += event.text;
                        upsertAssistant(accumulated);
                    } else if (event?.type === "model" && typeof event.model === "string") {
                        // First event is the requested model; a second one means
                        // the backend fell back to another model.
                        if (firstModel === null) firstModel = event.model;
                        else if (event.model !== firstModel) warnModelSwitch(event.model);
                    } else if (event?.type === "done") {
                        finalText = typeof event.fullText === "string" && event.fullText ? event.fullText : null;
                    } else if (event?.type === "error") {
                        streamError = event.message || "AI error";
                    }
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) buffer += decoder.decode(value, { stream: true });

                    let separator;
                    while ((separator = buffer.indexOf("\n\n")) !== -1) {
                        const rawEvent = buffer.slice(0, separator);
                        buffer = buffer.slice(separator + 2);
                        for (const line of rawEvent.split("\n")) {
                            if (!line.startsWith("data:")) continue;
                            try {
                                handleEvent(JSON.parse(line.slice(5).trim()));
                            } catch { /* ignore malformed SSE lines */ }
                        }
                    }
                }

                if (streamError) {
                    if (accumulated) {
                        setMessages(prev => [...prev, { id: "err-" + Date.now(), role: "assistant", content: `⚠️ ${streamError}` }]);
                    } else {
                        upsertAssistant(`⚠️ ${streamError}`);
                    }
                    setIsLoading(false);
                    return;
                }

                responseContent = finalText ?? accumulated;
                if (!responseContent.trim()) responseContent = "Sorry, I couldn't process that.";
                upsertAssistant(responseContent);
            } else {
                // Plain JSON answer (older backend or a proxy that buffers SSE).
                const data = await res.json();
                responseContent = data.response || "Sorry, I couldn't process that.";

                if (data.usedModel && data.usedModel !== selectedModel) {
                    warnModelSwitch(data.usedModel);
                }

                upsertAssistant(responseContent);
            }

            const aiMessage: Message = { id: assistantId, role: "assistant", content: responseContent };

            if (isAutoRun) {
                const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
                const codeMatches: RegExpExecArray[] = [];
                let blockMatch: RegExpExecArray | null;
                while ((blockMatch = codeBlockRegex.exec(responseContent)) !== null) {
                    codeMatches.push(blockMatch);
                }

                if (codeMatches.length > 0 && autoRunStepsRef.current >= AUTO_RUN_MAX_STEPS) {
                    setMessages(prev => [...prev, {
                        id: "autorun-cap-" + Date.now(),
                        role: "assistant",
                        content: `⏸ Auto-run paused after ${AUTO_RUN_MAX_STEPS} automated steps to avoid a loop. Send a message to continue, or run commands manually.`
                    }]);
                    setIsLoading(false);
                } else if (codeMatches.length > 0) {
                    autoRunStepsRef.current += 1;
                    const fullScript = codeMatches.map(match => match[2].trim()).join("\n");

                    const startLength = terminalHistory?.current?.length || 0;
                    runCommand(fullScript);
                    setIsLoading(true);

                    // Wait for the terminal to go quiet instead of a fixed 4s,
                    // so long-running commands get their full output analyzed.
                    const POLL_MS = 1500;
                    const MAX_WAIT_MS = 45000;
                    const NO_OUTPUT_GIVE_UP_MS = 6000;
                    let waited = 0;
                    let lastLength = startLength;

                    const finalizeAutoRun = () => {
                        const newOutput = terminalHistory?.current?.substring(startLength) || "";

                        if (newOutput.trim().length > 0) {
                            const autoMsg: Message = {
                                id: Date.now().toString(),
                                role: "user",
                                content: `[AUTOMATED SYSTEM OUTPUT]\nThe command has been executed. Here is the output:\n\`\`\`\n${newOutput}\n\`\`\`\n\nPlease analyze this output and confirm if it was successful or if further actions are needed. Answer briefly.`
                            };

                            processAiInteraction([...conversationHistory, aiMessage, autoMsg], `The user has auto-run mode enabled. The command you provided was executed. The output was: ${newOutput}`);
                        } else {
                            setIsLoading(false);
                        }
                    };

                    const poll = () => {
                        autoRunTimerRef.current = window.setTimeout(() => {
                            autoRunTimerRef.current = null;
                            waited += POLL_MS;
                            const currentLength = terminalHistory?.current?.length || 0;
                            const stillGrowing = currentLength > lastLength;
                            const hasOutput = currentLength > startLength;
                            lastLength = currentLength;

                            if (waited < MAX_WAIT_MS && (stillGrowing || (!hasOutput && waited < NO_OUTPUT_GIVE_UP_MS))) {
                                poll();
                                return;
                            }

                            finalizeAutoRun();
                        }, POLL_MS);
                    };
                    poll();
                } else {
                    setIsLoading(false);
                }
            } else {
                setIsLoading(false);
            }

        } catch (error: any) {
            if (error?.name === "AbortError") {
                // Partial streamed text (if any) stays visible.
                setIsLoading(false);
                return;
            }
            console.error(error);
            setMessages(prev => [
                ...prev,
                { id: Date.now().toString(), role: "assistant", content: "Error connecting to AI service." },
            ]);
            setIsLoading(false);
        }
    };

    useEffect(() => {
        const handleTerminalIssueAction = (event: Event) => {
            const detail = (event as CustomEvent<{ action?: "analyze" | "fix" }>).detail;
            if (!detail?.action) return;

            if (detail.action === "analyze") {
                setInput(diagnosticPromptValue);
                return;
            }

            if (detail.action === "fix") {
                void requestFixIt();
            }
        };

        window.addEventListener("terminal-issue-action", handleTerminalIssueAction as EventListener);
        return () => {
            window.removeEventListener("terminal-issue-action", handleTerminalIssueAction as EventListener);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [diagnosticPromptValue, latestIssue?.id]);

    const lastAssistantId = [...messages].reverse().find(m => m.role === "assistant")?.id;

    return (
        <div className="flex flex-col h-full text-zinc-300 bg-ink-850/40 relative">
            <div
                className="h-10 px-4 border-b border-white/5 flex items-center justify-between bg-ink-850/70 shrink-0"
                style={{ WebkitAppRegion: "drag" } as any}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                    <span className="font-bold text-xs text-zinc-200 uppercase tracking-wider">AI Assistant</span>
                </div>
                <button
                    onClick={clearConversation}
                    className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                    title="Clear conversation (forgets context)"
                    style={{ WebkitAppRegion: "no-drag" } as any}
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="px-3 py-2 border-b border-white/5 bg-ink-900/50 flex items-center justify-between gap-3 shrink-0" style={{ WebkitAppRegion: "no-drag" } as any}>
                <div className="flex min-w-0 items-center gap-1.5">
                    {isRecommendedModelSelected && (
                        <div
                            className="flex items-center justify-center rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 px-1.5 py-1 shrink-0"
                            title="Recommended model"
                        >
                            <Star className="w-3 h-3 fill-current" />
                        </div>
                    )}
                    <Select
                        value={selectedModel}
                        onChange={handleModelChange}
                        options={MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                        className={cn(
                            "min-w-0 max-w-[210px] py-1.5 text-[11px]",
                            isRecommendedModelSelected && "border-amber-500/40"
                        )}
                    />
                </div>
                <button
                    onClick={toggleAutoRun}
                    className={cn(
                        "px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-bold border",
                        isAutoRun
                            ? "bg-amber-500/20 text-amber-300 border-amber-500/50"
                            : "text-zinc-400 border-white/5 hover:bg-white/5 hover:text-zinc-300"
                    )}
                    title="Auto-Run Commands"
                >
                    <Zap className="w-3 h-3 fill-current" />
                    {isAutoRun ? "AUTO ON" : "AUTO"}
                </button>
            </div>

            <div
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin p-4 space-y-5"
                ref={messagesContainerRef}
                style={{ WebkitAppRegion: "no-drag" } as any}
            >
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={cn(
                            "group flex flex-col gap-1.5 max-w-[92%]",
                            msg.role === "user" ? "ml-auto items-end" : "items-start"
                        )}
                    >
                        <div className="flex items-center gap-1.5 px-1">
                            {msg.role === "assistant"
                                ? <Bot className="w-3 h-3 text-brand-400" />
                                : <User className="w-3 h-3 text-zinc-400" />}
                            <span className="text-[11px] text-zinc-400 font-medium uppercase tracking-wide">
                                {msg.role === "user" ? "You" : "ShellMind"}
                            </span>
                        </div>

                        <div className={cn(
                            "px-3.5 py-2.5 text-sm leading-relaxed rounded-xl w-full",
                            msg.role === "user"
                                ? "bg-ink-650 text-zinc-100 border border-white/10 rounded-tr-sm"
                                : "bg-ink-800/60 border border-white/5 rounded-tl-sm"
                        )}>
                            {renderMessage(msg.content)}
                        </div>

                        {msg.role === "assistant" && msg.content.length > 24 && (
                            <div className="flex items-center gap-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => copyMessage(msg)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition">
                                    {copiedId === msg.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                    {copiedId === msg.id ? "Copied" : "Copy"}
                                </button>
                                {msg.id === lastAssistantId && !isLoading && (
                                    <button onClick={regenerate} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-300 transition">
                                        <RefreshCw className="w-3 h-3" /> Retry
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                ))}
                {isLoading && (
                    <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5 px-1">
                            <Bot className="w-3 h-3 text-brand-400" />
                            <span className="text-[11px] text-zinc-400 font-medium uppercase tracking-wide">ShellMind</span>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-xl bg-ink-800/60 border border-white/5 px-3.5 py-3">
                            <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse" />
                            <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse [animation-delay:160ms]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse [animation-delay:320ms]" />
                        </div>
                    </div>
                )}
            </div>

            <div className="p-3 border-t border-white/5 bg-ink-850/70 shrink-0" style={{ WebkitAppRegion: "no-drag" } as any}>
                <div className="relative">
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        placeholder="Ask anything, or describe what you want to do..."
                        className="w-full bg-ink-900 text-zinc-200 text-sm p-3 pr-11 rounded-xl border border-white/10 focus:border-brand-500/60 focus:outline-none resize-none scrollbar-hide min-h-[78px]"
                    />
                    {isLoading ? (
                        <button
                            onClick={stopGeneration}
                            className="absolute right-2 bottom-2 flex items-center justify-center rounded-lg bg-rose-600/90 p-2 text-white hover:bg-rose-500 transition"
                            title="Stop generating"
                        >
                            <Square className="w-3.5 h-3.5 fill-current" />
                        </button>
                    ) : (
                        <button
                            onClick={handleSend}
                            disabled={!input.trim()}
                            className="absolute right-2 bottom-2 flex items-center justify-center rounded-lg bg-brand-500 p-2 text-ink-900 disabled:opacity-30 disabled:bg-white/5 disabled:text-zinc-400 hover:bg-brand-400 transition"
                            title="Send (Enter)"
                        >
                            <Send className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>

                {latestIssue && (
                    <div className="mt-3 rounded-xl border border-white/10 bg-ink-900/60 px-3 py-2.5">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-400 mb-1">
                                    <AlertTriangle className={cn("w-3 h-3", latestIssue.type === "error" ? "text-rose-400" : "text-amber-400")} />
                                    Last SSH issue
                                </div>
                                <div className={cn(
                                    "text-xs font-medium break-words max-h-24 overflow-hidden",
                                    latestIssue.type === "error" ? "text-rose-300" : "text-amber-300"
                                )}>
                                    {latestIssue.message}
                                </div>
                                {latestIssue.details && (
                                    <div className="text-[11px] text-zinc-400 mt-1 font-mono max-h-10 overflow-hidden break-words">
                                        {latestIssue.details}
                                    </div>
                                )}
                            </div>
                            <div className="flex shrink-0 gap-1.5">
                                <button
                                    onClick={() => latestIssue && onDismissTerminalIssue?.(latestIssue.id)}
                                    className="rounded-lg border border-white/10 p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                    title="Dismiss"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                                <button
                                    onClick={() => setInput(diagnosticPromptValue)}
                                    className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                    title="Ask AI to analyze this error"
                                >
                                    <Terminal className="w-3 h-3" /> Analyze
                                </button>
                                <button
                                    onClick={requestFixIt}
                                    disabled={fixItLoading}
                                    className={cn(
                                        "flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors",
                                        fixItLoading
                                            ? "bg-amber-600/70 text-white border-amber-500"
                                            : "border-amber-700/60 text-amber-300 hover:bg-amber-500/15"
                                    )}
                                    title="Ask AI for the exact fix"
                                >
                                    <Zap className="w-3 h-3" /> Fix it
                                </button>
                            </div>
                        </div>

                        {recentIssues.length > 1 && (
                            <div className="mt-2 space-y-1">
                                <div className="flex justify-end">
                                    <button
                                        onClick={() => onClearTerminalIssues?.()}
                                        className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                                    >
                                        Clear all
                                    </button>
                                </div>
                                {recentIssues.map(issue => (
                                    <div key={issue.id} className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/30 px-2 py-1">
                                        <button
                                            onClick={() => setInput(`${DIAGNOSTIC_PROMPT}\n\nTerminal issue:\n${formatIssueEntry(issue)}\n\nActive server: ${activeServer ? `${activeServer.name} (${activeServer.osDetail || activeServer.type})` : "None"}`)}
                                            className="block min-w-0 flex-1 text-left hover:text-zinc-100 transition-colors"
                                        >
                                            <div className={cn(
                                                "text-[11px] font-medium truncate",
                                                issue.type === "error" ? "text-rose-300" : "text-amber-300"
                                            )}>
                                                {issue.message}
                                            </div>
                                        </button>
                                        <button
                                            onClick={() => onDismissTerminalIssue?.(issue.id)}
                                            className="shrink-0 rounded p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {fixItLoading && (
                            <div className="mt-2 text-xs text-zinc-400 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                                Generating fix...
                            </div>
                        )}

                        {fixItSuggestion && !fixItLoading && (
                            <div className="mt-2 space-y-2">
                                <div className="rounded-lg border border-white/10 bg-black/60 p-2">
                                    <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1">Suggested command</div>
                                    <pre className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words">{fixItSuggestion}</pre>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { navigator.clipboard.writeText(fixItSuggestion); toast.success("Copied"); }}
                                        className="flex-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-white/5"
                                    >
                                        Copy
                                    </button>
                                    <button
                                        onClick={() => runCommand(fixItSuggestion)}
                                        className="flex-1 rounded-lg bg-brand-500/15 border border-brand-500/30 px-3 py-1.5 text-[11px] text-brand-300 hover:bg-brand-500/25"
                                    >
                                        Run
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className="flex justify-between items-center mt-2 px-1">
                    <span className="text-[11px] text-zinc-400">Context: {activeServer ? "Active" : "None"}</span>
                    <span className="text-[11px] text-zinc-400">Enter to send · Shift+Enter newline</span>
                </div>
            </div>

            {autoRunConfirmOpen && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 backdrop-blur-sm px-4 animate-fade-in">
                    <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-ink-800 shadow-panel animate-scale-in">
                        <div className="px-4 py-3 border-b border-white/5">
                            <div className="text-sm font-semibold text-zinc-100">Enable Auto-Run</div>
                            <div className="text-xs text-zinc-400 mt-1">
                                AI suggestions will be executed automatically when they contain commands.
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                                This can run commands on the active server without an extra confirmation step.
                            </div>
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={cancelEnableAutoRun}
                                    className="px-3 py-2 rounded-lg border border-white/10 text-sm text-zinc-300 hover:bg-white/5"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmEnableAutoRun}
                                    className="px-3 py-2 rounded-lg bg-amber-500 text-sm text-black font-medium hover:bg-amber-400"
                                >
                                    Enable
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
