import { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import TerminalComponent from '@/components/Terminal';
import RdpComponent from '@/components/Rdp';
import FileExplorer from '@/components/FileExplorer';
import Chat from '@/components/Chat';
import AddServerModal from '@/components/AddServerModal';
import SettingsModal from '@/components/SettingsModal';
import StatusDashboard from '@/components/StatusDashboard';
import { Terminal as TerminalIcon, Monitor, Activity, FileText, MessageSquare } from 'lucide-react';
import { clsx } from 'clsx';
import { API_BASE } from '@/config';
import { StatusDot, statusLabel, type ConnState } from '@/components/ui';

type TerminalIssueType = 'error' | 'warning';

interface TerminalIssue {
    id: string;
    type: TerminalIssueType;
    message: string;
    details?: string;
    timestamp: number;
}

const stripAnsiCodes = (value: string) =>
    value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');

const normalizeTerminalText = (value: string) =>
    stripAnsiCodes(value).replace(/\r/g, '');

const summarizeIssueText = (value: string, maxLength = 180) => {
    const compact = value
        .replace(/\s+/g, ' ')
        .replace(/\s*([;:,])\s*/g, '$1 ')
        .trim();

    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength).trimEnd()}...`;
};

function App() {
    const [activeServer, setActiveServer] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<'ssh' | 'rdp' | 'sftp' | 'status'>('ssh');
    const [isAddServerOpen, setIsAddServerOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [servers, setServers] = useState<any[]>([]);
    const [editingServer, setEditingServer] = useState<any>(null);
    const [isChatOpen, setIsChatOpen] = useState(true);
    const [connState, setConnState] = useState<ConnState>('connecting');

    // Terminal History Buffer (Ref to avoid re-renders)
    const terminalHistoryRef = useRef('');
    const terminalLineBufferRef = useRef('');
    const [terminalIssues, setTerminalIssues] = useState<TerminalIssue[]>([]);
    const recentTerminalIssueKeysRef = useRef<Map<string, number>>(new Map());
    const lastTerminalIssueIdRef = useRef<string | null>(null);

    const recordTerminalIssue = (type: TerminalIssueType, message: string, details?: string) => {
        const normalizedMessage = summarizeIssueText(message);
        const normalizedDetails = details
            ?.split(/\n+/)
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 4)
            .map(line => summarizeIssueText(line, 220))
            .join('\n');
        const issueKey = `${type}:${normalizedMessage}:${normalizedDetails || ''}`.toLowerCase();
        const now = Date.now();
        const lastSeenAt = recentTerminalIssueKeysRef.current.get(issueKey) || 0;

        if (now - lastSeenAt < 1200) {
            return;
        }

        recentTerminalIssueKeysRef.current.set(issueKey, now);
        if (recentTerminalIssueKeysRef.current.size > 50) {
            const first = recentTerminalIssueKeysRef.current.keys().next().value;
            if (first) {
                recentTerminalIssueKeysRef.current.delete(first);
            }
        }

        const entry: TerminalIssue = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            type,
            message: normalizedMessage,
            details: normalizedDetails,
            timestamp: now
        };

        lastTerminalIssueIdRef.current = entry.id;
        setTerminalIssues(prev => [...prev, entry].slice(-20));
    };

    const appendTerminalIssueDetails = (detailsLine: string) => {
        const trimmedDetails = summarizeIssueText(detailsLine, 220);
        if (!trimmedDetails || !lastTerminalIssueIdRef.current) return;

        setTerminalIssues(prev => {
            if (!prev.length) return prev;

            const next = [...prev];
            const lastIndex = next.length - 1;
            const last = next[lastIndex];

            if (last.id !== lastTerminalIssueIdRef.current) {
                return prev;
            }

            next[lastIndex] = {
                ...last,
                details: last.details ? `${last.details}\n${trimmedDetails}` : trimmedDetails,
                timestamp: Date.now()
            };

            return next;
        });
    };

    const dismissTerminalIssue = (issueId: string) => {
        setTerminalIssues(prev => prev.filter(issue => issue.id !== issueId));
        if (lastTerminalIssueIdRef.current === issueId) {
            lastTerminalIssueIdRef.current = null;
        }
    };

    const clearTerminalIssues = () => {
        setTerminalIssues([]);
        lastTerminalIssueIdRef.current = null;
    };

    const classifyTerminalLine = (line: string): TerminalIssueType | null => {
        const trimmed = line.trim();
        if (!trimmed) return null;

        if (/^\s*(error|fatal|exception)\b/i.test(trimmed)) return 'error';
        if (/^(bash|sh|zsh):\s*/i.test(trimmed) && /not found|permission denied|no such file/i.test(trimmed)) return 'error';
        if (/^(powershell|cmd|cmdlet)\b/i.test(trimmed) && /not recognized|cannot find path|access is denied|fullyqualifiederrorid|exception/i.test(trimmed)) return 'error';

        if (/permission denied|operation not permitted|access denied|command not found|not recognized|no such file or directory|cannot open|cannot stat|failed|error:|fatal:|exception|refused|timed out|no route to host|connection refused|denied|no match was found|unable to find package provider|provider .* not found|could not find package provider|the term .* is not recognized|cannot find path|invalidoperationexception|commandnotfoundexception|objectnotfound|segmentation fault|broken pipe|auth failed|authentication failed|unauthorized|forbidden/i.test(trimmed)) {
            return 'error';
        }

        if (/warning:|deprecated|already exists|skipping|unable to download|already installed|no matches found|retrying|transient|rate limit/i.test(trimmed)) {
            return 'warning';
        }

        return null;
    };

    const isTerminalDetailLine = (line: string) => {
        const trimmed = line.trim();
        return /^(at line:|categoryinfo|fullyqualifiederrorid|positionalparameter|scriptstacktrace| \+| \~|at c:\\|at \/|line:\s*\d+\s+char:\s*\d+|statuscode:|stderr:|stdout:|details?:)/i.test(trimmed) || /^\+/.test(trimmed);
    };

    const handleTerminalOutput = (data: string) => {
        const cleanOutput = normalizeTerminalText(data);
        terminalHistoryRef.current += cleanOutput;
        terminalLineBufferRef.current += cleanOutput;
        // Keep last 10,000 chars to avoid memory issues but have enough context
        if (terminalHistoryRef.current.length > 10000) {
            terminalHistoryRef.current = terminalHistoryRef.current.slice(-10000);
        }

        if (terminalLineBufferRef.current.length > 4000) {
            terminalLineBufferRef.current = terminalLineBufferRef.current.slice(-4000);
        }

        const terminalLines = terminalLineBufferRef.current
            .split(/\n/)
            .map(line => line.trim())
        terminalLineBufferRef.current = terminalLines.pop() || '';

        for (const line of terminalLines) {
            if (!line) continue;

            if (isTerminalDetailLine(line)) {
                appendTerminalIssueDetails(line);
                continue;
            }

            const issueType = classifyTerminalLine(line);
            if (issueType) {
                recordTerminalIssue(issueType, line);
            }
        }

        const fallbackIssueLine = cleanOutput
            .split(/\n+/)
            .map(line => line.trim())
            .filter(Boolean)
            .reverse()
            .find(line => classifyTerminalLine(line) === 'error');

        if (fallbackIssueLine) {
            recordTerminalIssue('error', fallbackIssueLine);
        }
    };

    const fetchServers = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/servers`);
            const data = await res.json();
            if (data.message === 'success') {
                setServers(data.data);
            }
        } catch (e) {
            console.error('Failed to fetch servers', e);
        }
    };

    useEffect(() => {
        fetchServers();
    }, []);

    const handleSelectServer = (server: any) => {
        setActiveServer(server);
        terminalHistoryRef.current = '';
        terminalLineBufferRef.current = '';
        setTerminalIssues([]);
        recentTerminalIssueKeysRef.current.clear();
        lastTerminalIssueIdRef.current = null;
        setConnState(server.type === 's3' ? 'connected' : 'connecting');
        setIsChatOpen(server.type !== 's3');
        setActiveTab((server.type === 'ftp' || server.type === 's3') ? 'sftp' : 'ssh');
    };

    const handleEditServer = (server: any) => {
        setEditingServer(server);
        setIsAddServerOpen(true);
    };

    const handleServerDeleted = (id: number) => {
        if (activeServer?.id === id) {
            setActiveServer(null);
        }
        fetchServers();
    };

    const handleCloseModal = () => {
        setIsAddServerOpen(false);
        setEditingServer(null);
    };

    const handleOsDetected = (osName: string) => {
        setActiveServer((prev: any) => ({ ...prev, osDetail: osName }));
        if (activeServer?.id) {
            fetch(`${API_BASE}/api/servers/${activeServer.id}/os`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ os_detail: osName })
            }).catch(console.error);
        }
    };

    const isWindows = activeServer?.type === 'windows';
    const isS3Connection = activeServer?.type === 's3';
    const chatEnabled = !isS3Connection;
    const shouldShowChat = chatEnabled && isChatOpen;

    useEffect(() => {
        if (isS3Connection && isChatOpen) {
            setIsChatOpen(false);
        }
    }, [isS3Connection, isChatOpen]);

    useEffect(() => {
        const handleTerminalChatPrompt = () => {
            if (!activeServer || activeServer.type === 's3') return;
            setIsChatOpen(true);
        };

        window.addEventListener('terminal-chat-prompt', handleTerminalChatPrompt);
        return () => {
            window.removeEventListener('terminal-chat-prompt', handleTerminalChatPrompt);
        };
    }, [activeServer]);

    // Real connection state reported by the active terminal session.
    useEffect(() => {
        const handleConnection = (e: Event) => {
            const detail = (e as CustomEvent<{ serverId?: number; state?: ConnState }>).detail;
            if (!detail || !activeServer || detail.serverId !== activeServer.id) return;
            if (detail.state) setConnState(detail.state);
        };
        window.addEventListener('shellmind:connection', handleConnection as EventListener);
        return () => window.removeEventListener('shellmind:connection', handleConnection as EventListener);
    }, [activeServer?.id]);

    // Detect Electron
    const isElectron =
        navigator.userAgent.toLowerCase().includes(' electron/') ||
        window.location.protocol === 'file:';
    const electronWindowControlsSpacer = isElectron ? '168px' : undefined;

    return (
        <div className={clsx(
            "h-screen w-screen bg-ink-900 text-zinc-300 grid overflow-hidden font-sans transition-all duration-300 ease-in-out",
            shouldShowChat ? "grid-cols-[260px_1fr_380px]" : "grid-cols-[260px_1fr_0px]"
        )}>
            {/* Column 1: Sidebar */}
            <aside className="border-r border-white/5 bg-ink-850/60 flex flex-col h-full overflow-hidden min-h-0">
                <Sidebar
                    servers={servers}
                    onSelectServer={handleSelectServer}
                    activeServerId={activeServer?.id}
                    onAddServer={() => setIsAddServerOpen(true)}
                    onEditServer={handleEditServer}
                    onOpenSettings={() => setIsSettingsOpen(true)}
                    onServerDeleted={handleServerDeleted}
                />
            </aside>

            {/* Column 2: Workspace (Terminal/RDP) */}
            <main className="flex flex-col min-w-0 bg-ink-900 relative h-full overflow-hidden min-h-0">
                {/* Workspace Header */}
                <header
                    className={clsx(
                        "h-10 border-b border-white/5 flex items-center gap-4 px-4 bg-ink-850/40 shrink-0"
                    )}
                    style={{ WebkitAppRegion: isElectron ? 'drag' : undefined } as any}
                >
                    <div className="flex items-center gap-4 min-w-0 flex-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        {activeServer ? (
                            <div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden pl-2">
                                <StatusDot state={connState} />
                                <span className="font-medium text-zinc-100 truncate max-w-[150px] md:max-w-xs">{activeServer.name}</span>
                                <span className="text-zinc-500 font-mono text-xs truncate shrink-0">({activeServer.ip})</span>
                                {activeServer.type !== 's3' && connState !== 'connected' && (
                                    <span className={clsx(
                                        "text-[11px] font-medium shrink-0",
                                        connState === 'error' ? "text-rose-300"
                                            : connState === 'connecting' ? "text-amber-300"
                                            : "text-zinc-400"
                                    )}>
                                        · {statusLabel(connState)}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-zinc-400 text-sm italic">No connection selected</span>
                        )}
                    </div>

                    <div className="flex h-full items-center gap-4 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        {/* Tab Switcher - Only visible when active */}
                        {activeServer && (
                            <div className="flex h-full mr-2">
                                {activeServer.type !== 's3' && (
                                    <button
                                        onClick={() => setActiveTab('ssh')}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-white/5",
                                            activeTab === 'ssh' ? "bg-white/[0.06] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300"
                                        )}
                                    >
                                        <TerminalIcon className="w-4 h-4" />
                                        {activeServer.type === 'ftp' || activeServer.type === 'local' ? "Terminal" : (isWindows ? "CMD / PowerShell" : "SSH")}
                                    </button>
                                )}

                                {activeServer.type !== 'local' && (
                                    <button
                                        onClick={() => setActiveTab('sftp')}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-white/5",
                                            activeTab === 'sftp' ? "bg-white/[0.06] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300"
                                        )}
                                    >
                                        <FileText className="w-4 h-4" />
                                        Files
                                    </button>
                                )}

                                {activeServer.type !== 'ftp' && activeServer.type !== 's3' && activeServer.type !== 'local' && (
                                    <button
                                        onClick={() => setActiveTab('status')}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-white/5",
                                            activeTab === 'status' ? "bg-white/[0.06] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300"
                                        )}
                                    >
                                        <Activity className="w-4 h-4" />
                                        Status
                                    </button>
                                )}

                                {isWindows && (
                                    <button
                                        onClick={() => setActiveTab('rdp')}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-white/5",
                                            activeTab === 'rdp' ? "bg-white/[0.06] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300"
                                        )}
                                    >
                                        <Monitor className="w-4 h-4" />
                                        RDP
                                    </button>
                                )}
                            </div>
                        )}

                        <button
                            onClick={() => {
                                if (chatEnabled) {
                                    setIsChatOpen(!isChatOpen);
                                }
                            }}
                            disabled={!chatEnabled}
                            className={clsx(
                                "p-1.5 rounded transition-colors shrink-0",
                                chatEnabled
                                    ? (isChatOpen ? "text-brand-400 hover:bg-white/5" : "text-zinc-400 hover:bg-white/5")
                                    : "text-zinc-500 opacity-50 cursor-not-allowed"
                            )}
                            title={
                                chatEnabled
                                    ? (isChatOpen ? "Close Chat" : "Open Chat")
                                    : "AI Assistant disabled for S3"
                            }
                        >
                            <MessageSquare className="w-4 h-4" />
                        </button>
                    </div>
                    {isElectron && !isChatOpen && (
                        <div
                            aria-hidden="true"
                            className="shrink-0 h-full"
                            style={{ width: electronWindowControlsSpacer } as any}
                        />
                    )}
                </header>

                {/* Workspace Content */}
                <div className="flex-1 relative bg-ink-900 min-h-0 overflow-hidden">
                    {activeServer ? (
                        <>
                            {activeServer.type !== 's3' && (
                                <div className={clsx("absolute inset-0", activeTab === 'ssh' ? "block" : "hidden")}>
                                    <TerminalComponent
                                        key={`terminal-ssh-${activeServer.id}`}
                                        server={activeServer}
                                        onOsDetected={handleOsDetected}
                                        onOutput={handleTerminalOutput}
                                        isActive={activeTab === 'ssh'}
                                    />
                                </div>
                            )}

                            {activeServer.type !== 'ftp' && activeServer.type !== 's3' && activeServer.type !== 'local' && (
                                <div className={clsx("absolute inset-0", activeTab === 'status' ? "block" : "hidden")}>
                                    <StatusDashboard
                                        server={activeServer}
                                        isVisible={activeTab === 'status'}
                                    />
                                </div>
                            )}

                            {isWindows && (
                                <div className={clsx("absolute inset-0 bg-ink-900", activeTab === 'rdp' ? "block" : "hidden")}>
                                    <RdpComponent server={activeServer} />
                                </div>
                            )}

                            {activeServer.type !== 'local' && (
                                <div className={clsx("absolute inset-0 bg-ink-900", activeTab === 'sftp' ? "block" : "hidden")}>
                                    <FileExplorer server={activeServer} isVisible={activeTab === 'sftp'} />
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="text-center">
                                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/5 bg-white/[0.02] text-brand-400/60">
                                    <TerminalIcon className="w-8 h-8" />
                                </div>
                                <p className="text-sm font-medium text-zinc-400">No connection selected</p>
                                <p className="mt-1 text-xs text-zinc-500">Pick a server from the sidebar to get started</p>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            {/* Column 3: AI Chat */}
            {chatEnabled && (
                <aside
                    className={clsx(
                        "border-l border-white/5 bg-ink-850/30 flex flex-col h-full overflow-hidden min-h-0 transition-all duration-300 relative",
                        isChatOpen ? "w-[380px]" : "w-0 border-l-0"
                    )}
                >
                    {isChatOpen && (
                        <div className="w-[380px] h-full absolute right-0 top-0 bottom-0">
                            <Chat
                                activeServer={activeServer}
                                connectionState={connState}
                                terminalHistory={terminalHistoryRef}
                                terminalIssues={terminalIssues}
                                onDismissTerminalIssue={dismissTerminalIssue}
                                onClearTerminalIssues={clearTerminalIssues}
                            />
                        </div>
                    )}
                </aside>
            )}

            <AddServerModal
                isOpen={isAddServerOpen}
                onClose={handleCloseModal}
                onAdd={fetchServers}
                initialData={editingServer}
            />

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
            />
        </div>
    );
}

export default App;
