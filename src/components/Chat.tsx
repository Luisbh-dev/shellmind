"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Bot, RotateCw, Sparkles, Play, Zap, Terminal, AlertTriangle, X } from "lucide-react";
import { clsx } from "clsx";
import ReactMarkdown from "react-markdown";

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
    terminalHistory?: React.MutableRefObject<string>;
    terminalIssues?: TerminalIssue[];
}

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

export default function Chat({ activeServer, terminalHistory, terminalIssues }: ChatProps) {
    const [messages, setMessages] = useState<Message[]>([
        { id: "1", role: "assistant", content: "ShellMind AI ready. Select a server to begin." }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isAutoRun, setIsAutoRun] = useState(false);
    const [selectedModel, setSelectedModel] = useState("gemini-2.5-flash");
    const [fixItLoading, setFixItLoading] = useState(false);
    const [fixItSuggestion, setFixItSuggestion] = useState("");
    const [issueToast, setIssueToast] = useState<TerminalIssue | null>(null);
    const [autoRunConfirmOpen, setAutoRunConfirmOpen] = useState(false);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const pendingFixItRequestRef = useRef(0);
    const issueToastTimerRef = useRef<number | null>(null);
    const lastAnnouncedIssueIdRef = useRef<string | null>(null);

    const latestIssue = terminalIssues?.[terminalIssues.length - 1] || null;
    const recentIssues = terminalIssues?.slice(-3).reverse() || [];

    useEffect(() => {
        if (!latestIssue || latestIssue.id === lastAnnouncedIssueIdRef.current) {
            return;
        }

        lastAnnouncedIssueIdRef.current = latestIssue.id;
        setIssueToast(latestIssue);

        if (issueToastTimerRef.current) {
            window.clearTimeout(issueToastTimerRef.current);
        }

        issueToastTimerRef.current = window.setTimeout(() => {
            setIssueToast(current => (current?.id === latestIssue.id ? null : current));
        }, 6000);

        return () => {
            if (issueToastTimerRef.current) {
                window.clearTimeout(issueToastTimerRef.current);
                issueToastTimerRef.current = null;
            }
        };
    }, [latestIssue?.id]);

    const diagnosticPromptValue = latestIssue
        ? `${DIAGNOSTIC_PROMPT}\n\nRecent terminal issues:\n${terminalIssues?.slice(-8).map(formatIssueEntry).join("\n")}\n\nActive server: ${activeServer ? `${activeServer.name} (${activeServer.osDetail || activeServer.type})` : "None"}`
        : (activeServer
            ? `${DIAGNOSTIC_PROMPT}\n\nActive server: ${activeServer.name} (${activeServer.osDetail || activeServer.type})`
            : DIAGNOSTIC_PROMPT);

    useEffect(() => {
        fetch("http://localhost:3001/api/config/model")
            .then(res => res.json())
            .then(data => {
                if (data.model) setSelectedModel(data.model);
            })
            .catch(err => console.error("Failed to load model config", err));
    }, []);

    const handleModelChange = async (newModel: string) => {
        setSelectedModel(newModel);
        try {
            await fetch("http://localhost:3001/api/config/model", {
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

    useEffect(() => {
        setMessages([
            {
                id: "init-" + (activeServer?.id || "default"),
                role: "assistant",
                content: activeServer
                    ? `ShellMind connected to **${activeServer.name}**. Ready to assist.`
                    : "ShellMind AI ready. Select a server to begin."
            }
        ]);
        setFixItSuggestion("");
        setIssueToast(null);
        lastAnnouncedIssueIdRef.current = null;

        if (issueToastTimerRef.current) {
            window.clearTimeout(issueToastTimerRef.current);
            issueToastTimerRef.current = null;
        }
    }, [activeServer?.id]);

    useEffect(() => {
        if (activeServer?.osDetail) {
            setMessages(prev => {
                if (prev.some(m => m.content.includes(activeServer.osDetail))) return prev;

                return [
                    ...prev,
                    {
                        id: "os-info-" + Date.now(),
                        role: "assistant",
                        content: `OS detected: **${activeServer.osDetail}**.\nI will tailor my commands for this system.`
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
        const lines = cmd.split("\n")
            .map(line => line.trim())
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
                cleanCmd += needsSeparator ? ` && ${line}` : ` ${line}`;
            }

            needsSeparator = !isContinuation;
        }

        window.dispatchEvent(new CustomEvent("run-terminal-command", { detail: cleanCmd }));
    };

    const renderMessage = (content: string) => {
        const parts = content.split(/(```[\s\S]*?```)/g);
        return parts.map((part, i) => {
            if (part.startsWith("```")) {
                const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
                const code = match ? match[2] : part.slice(3, -3);
                return (
                    <div key={i} className="my-2 bg-[#0f1115] rounded border border-zinc-800 overflow-hidden group">
                        <div className="flex justify-between items-center px-2 py-1 bg-zinc-900 border-b border-zinc-800">
                            <span className="text-[10px] text-zinc-500 font-mono">CODE</span>
                            <button
                                onClick={() => runCommand(code)}
                                className="flex items-center gap-1 text-[10px] bg-blue-900/30 text-blue-400 px-1.5 py-0.5 rounded hover:bg-blue-900/50 transition-colors"
                            >
                                <Play className="w-3 h-3" />
                                RUN
                            </button>
                        </div>
                        <pre className="p-2 text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap">
                            {code.trim()}
                        </pre>
                    </div>
                );
            }

            return (
                <div key={i} className="prose prose-invert prose-xs max-w-none mb-2 leading-normal text-zinc-300">
                    <ReactMarkdown>{part}</ReactMarkdown>
                </div>
            );
        });
    };

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input,
        };

        setMessages(prev => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        await processAiInteraction([...messages, userMessage]);
    };

    const requestFixIt = async () => {
        if (!latestIssue) return;

        const requestId = Date.now();
        pendingFixItRequestRef.current = requestId;
        setFixItLoading(true);
        setFixItSuggestion("");

        try {
            const historyContext = terminalHistory?.current
                ? `\n\n[LAST 50 LINES OF TERMINAL OUTPUT]\n${terminalHistory.current.slice(-3000)}`
                : "";

            const issueContext = terminalIssues?.length
                ? `\n\n[RECENT SSH FAILURES]\n${terminalIssues.slice(-8).map(formatIssueEntry).join("\n")}`
                : "";

            const context = (activeServer
                ? `Connected to ${activeServer.name} (${activeServer.osDetail || activeServer.type} - ${activeServer.ip})`
                : "No active server connection.") + historyContext + issueContext;

            const res = await fetch("http://localhost:3001/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "Return only the exact command that fixes this SSH error. If there are multiple commands, choose the safest single command first. No explanation, no bullets, only the command or a code block.",
                    context,
                    model: selectedModel
                })
            });

            const data = await res.json();
            const command = extractCommandFromResponse(data.response || "");

            if (pendingFixItRequestRef.current !== requestId) return;
            setFixItSuggestion(command || (data.response || "").trim());
        } catch {
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
        try {
            const historyContext = terminalHistory?.current
                ? `\n\n[LAST 50 LINES OF TERMINAL OUTPUT]\n${terminalHistory.current.slice(-3000)}`
                : "";

            const terminalIssueContext = terminalIssues?.length
                ? `\n\n[RECENT SSH FAILURES]\n${terminalIssues.slice(-8).map(formatIssueEntry).join("\n")}`
                : "";

            const context = (activeServer
                ? `Connected to ${activeServer.name} (${activeServer.osDetail || activeServer.type} - ${activeServer.ip})`
                : "No active server connection.") + historyContext + terminalIssueContext + (hiddenSystemContext ? `\n\n[SYSTEM UPDATE]: ${hiddenSystemContext}` : "");

            const lastMsg = conversationHistory[conversationHistory.length - 1];

            const res = await fetch("http://localhost:3001/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: lastMsg.content,
                    context: context,
                    model: selectedModel
                }),
            });

            const data = await res.json();
            const responseContent = data.response || "Sorry, I couldn't process that.";

            if (data.usedModel && data.usedModel !== selectedModel) {
                setSelectedModel(data.usedModel);
                const displayModelName = data.usedModel.includes("gemma") ? "Gemma 3 (Standard)" : "Flash 2.5 (Smart)";
                setMessages(prev => [...prev, {
                    id: "sys-switch-" + Date.now(),
                    role: "assistant",
                    content: `WARNING: Automatically switched to **${displayModelName}** due to provider limits.`
                }]);
            }

            const aiMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: responseContent,
            };

            setMessages(prev => [...prev, aiMessage]);

            if (isAutoRun) {
                const codeMatches = [...responseContent.matchAll(/```(\w*)\n?([\s\S]*?)```/g)];

                if (codeMatches.length > 0) {
                    const fullScript = codeMatches.map(match => match[2].trim()).join("\n");

                    const startLength = terminalHistory?.current?.length || 0;
                    runCommand(fullScript);
                    setIsLoading(true);

                    setTimeout(() => {
                        const currentLength = terminalHistory?.current?.length || 0;
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
                    }, 4000);
                } else {
                    setIsLoading(false);
                }
            } else {
                setIsLoading(false);
            }

        } catch (error) {
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
    }, [diagnosticPromptValue, latestIssue?.id, requestFixIt]);

    const isElectron = navigator.userAgent.toLowerCase().includes(" electron/");

    return (
        <div className="flex flex-col h-full text-zinc-300 bg-zinc-900/30 relative">
            <div
                className="h-10 px-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50 shrink-0"
                style={{
                    WebkitAppRegion: isElectron ? "drag" : undefined,
                    paddingRight: isElectron ? "138px" : undefined
                } as any}
            >
                <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
                    <Sparkles className="w-3.5 h-3.5 text-teal-500" />
                    {!isElectron && <span className="font-bold text-xs text-zinc-300 uppercase tracking-wider hidden sm:inline">AI Assistant</span>}

                    <select
                        value={selectedModel}
                        onChange={(e) => handleModelChange(e.target.value)}
                        className="bg-zinc-900 text-[10px] text-zinc-400 border border-zinc-700 rounded px-1 py-0.5 outline-none focus:border-teal-500 ml-2"
                    >
                        <option value="gemini-2.5-flash">Flash 2.5 (Smart)</option>
                        <option value="gemini-3-flash-preview">Flash 3 (Smartest)</option>
                        <option value="gemma-3-27b-it">Gemma 3 (Standard)</option>
                    </select>
                </div>
                <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
                    <button
                        onClick={toggleAutoRun}
                        className={clsx(
                            "p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] font-bold border",
                            isAutoRun
                                ? "bg-amber-500/20 text-amber-400 border-amber-500/50"
                                : "text-zinc-500 border-transparent hover:bg-zinc-800"
                        )}
                        title="Auto-Run Commands"
                    >
                        <Zap className="w-3 h-3 fill-current" />
                        {isAutoRun && "AUTO"}
                    </button>
                </div>
            </div>

            <div
                className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6"
                ref={messagesContainerRef}
                style={{ WebkitAppRegion: "no-drag" } as any}
            >
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={clsx(
                            "flex flex-col gap-1 max-w-[95%]",
                            msg.role === "user" ? "ml-auto items-end" : "items-start"
                        )}
                    >
                        <div className="flex items-center gap-2 mb-1">
                            {msg.role === "assistant" && <Bot className="w-3 h-3 text-teal-500" />}
                            <span className="text-[10px] text-zinc-500 font-medium uppercase">
                                {msg.role === "user" ? "You" : "ShellMind"}
                            </span>
                        </div>

                        <div className={clsx(
                            "px-3 py-2 text-sm leading-relaxed rounded-md w-full",
                            msg.role === "user"
                                ? "bg-zinc-800 text-zinc-100 border border-zinc-700"
                                : "text-zinc-300"
                        )}>
                            {renderMessage(msg.content)}
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 mb-1">
                            <Bot className="w-3 h-3 text-teal-500" />
                            <span className="text-[10px] text-zinc-500 font-medium uppercase">ShellMind</span>
                        </div>
                        <div className="flex items-center gap-2 text-zinc-500 text-xs pl-1">
                            <RotateCw className="w-3 h-3 animate-spin" />
                            <span>Generating response...</span>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-3 border-t border-zinc-800 bg-zinc-900/50 shrink-0" style={{ WebkitAppRegion: "no-drag" } as any}>
                {issueToast && (
                    <div className="mb-3 rounded border border-red-500/25 bg-red-500/10 px-3 py-2 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-red-300 mb-1">
                                    <AlertTriangle className="w-3 h-3 text-red-400" />
                                    New SSH issue
                                </div>
                                <div className="text-xs text-red-100 font-medium truncate">
                                    {issueToast.message}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    onClick={() => setInput(diagnosticPromptValue)}
                                    className="px-2 py-1 rounded border border-red-500/20 text-[10px] text-red-200 hover:bg-red-500/15 transition-colors"
                                >
                                    Analyze
                                </button>
                                <button
                                    onClick={requestFixIt}
                                    className="px-2 py-1 rounded border border-red-500/20 text-[10px] text-red-200 hover:bg-red-500/15 transition-colors"
                                >
                                    Fix it
                                </button>
                                <button
                                    onClick={() => setIssueToast(null)}
                                    className="p-1 rounded text-red-200/70 hover:text-red-100 hover:bg-red-500/10 transition-colors"
                                    aria-label="Dismiss issue notice"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        </div>
                    </div>
                )}

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
                        placeholder="Type a command or question..."
                        className="w-full bg-black text-zinc-200 text-sm p-3 pr-10 rounded border border-zinc-800 focus:border-zinc-600 focus:ring-0 focus:outline-none resize-none scrollbar-hide min-h-[80px]"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading}
                        className="absolute right-2 bottom-2 p-1.5 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-400 hover:text-white rounded transition-colors"
                    >
                        <Send className="w-3.5 h-3.5" />
                    </button>
                </div>

                {latestIssue && (
                    <div className="mt-3 rounded border border-zinc-800 bg-black/40 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                                    <AlertTriangle className={clsx("w-3 h-3", latestIssue.type === "error" ? "text-red-400" : "text-amber-400")} />
                                    Last SSH issue
                                </div>
                                <div className={clsx(
                                    "text-xs font-medium",
                                    latestIssue.type === "error" ? "text-red-300" : "text-amber-300"
                                )}>
                                    {latestIssue.message}
                                </div>
                                {latestIssue.details && (
                                    <div className="text-[10px] text-zinc-500 mt-1 font-mono truncate">
                                        {latestIssue.details}
                                    </div>
                                )}
                            </div>
                            <div className="flex shrink-0 gap-2">
                                <button
                                    onClick={() => setInput(diagnosticPromptValue)}
                                    className="px-2 py-1 rounded border border-zinc-700 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors flex items-center gap-1"
                                    title="Ask AI to analyze this SSH error"
                                >
                                    <Terminal className="w-3 h-3" />
                                    Analyze
                                </button>
                                <button
                                    onClick={requestFixIt}
                                    disabled={fixItLoading}
                                    className={clsx(
                                        "px-2 py-1 rounded border text-[10px] transition-colors flex items-center gap-1",
                                        fixItLoading
                                            ? "bg-amber-600/70 text-white border-amber-500"
                                            : "border-amber-700 text-amber-300 hover:bg-amber-500/15"
                                    )}
                                    title="Ask AI for the exact fix command"
                                >
                                    <Zap className="w-3 h-3" />
                                    Fix it
                                </button>
                            </div>
                        </div>

                        {recentIssues.length > 1 && (
                            <div className="mt-2 space-y-1">
                                {recentIssues.map(issue => (
                                    <button
                                        key={issue.id}
                                        onClick={() => setInput(`${DIAGNOSTIC_PROMPT}\n\nTerminal issue:\n${formatIssueEntry(issue)}\n\nActive server: ${activeServer ? `${activeServer.name} (${activeServer.osDetail || activeServer.type})` : "None"}`)}
                                        className="block w-full text-left rounded border border-zinc-800/70 bg-black/30 px-2 py-1 hover:bg-zinc-900 hover:border-zinc-700 transition-colors"
                                        title="Use this error in the AI prompt"
                                    >
                                        <div className={clsx(
                                            "text-[10px] font-medium truncate",
                                            issue.type === "error" ? "text-red-300" : "text-amber-300"
                                        )}>
                                            {issue.message}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}

                        {fixItLoading && (
                            <div className="mt-2 text-xs text-zinc-500 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                                Generating fix...
                            </div>
                        )}

                        {fixItSuggestion && !fixItLoading && (
                            <div className="mt-2 space-y-2">
                                <div className="rounded border border-zinc-800 bg-black/60 p-2">
                                    <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Suggested command</div>
                                    <pre className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words">{fixItSuggestion}</pre>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => navigator.clipboard.writeText(fixItSuggestion)}
                                        className="flex-1 rounded border border-zinc-700 px-3 py-1.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
                                    >
                                        Copy
                                    </button>
                                    <button
                                        onClick={() => runCommand(fixItSuggestion)}
                                        className="flex-1 rounded border border-zinc-700 px-3 py-1.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
                                    >
                                        Run
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

            <div className="flex justify-between items-center mt-2 px-1">
                    <span className="text-[10px] text-zinc-600">Context: {activeServer ? "Active" : "None"}</span>
                    <span className="text-[10px] text-zinc-700">Enter to send, Shift+Enter for new line</span>
                </div>
            </div>

            {autoRunConfirmOpen && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 backdrop-blur-[1px] px-4">
                    <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/40">
                        <div className="px-4 py-3 border-b border-zinc-800">
                            <div className="text-sm font-semibold text-zinc-100">Enable Auto-Run</div>
                            <div className="text-xs text-zinc-500 mt-1">
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
                                    className="px-3 py-2 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
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
