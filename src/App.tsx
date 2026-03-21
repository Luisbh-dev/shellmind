import { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import TerminalComponent from '@/components/Terminal';
import RdpComponent from '@/components/Rdp';
import FileExplorer from '@/components/FileExplorer';
import Chat from '@/components/Chat';
import AddServerModal from '@/components/AddServerModal';
import SettingsModal from '@/components/SettingsModal';
import { Terminal as TerminalIcon, Monitor, Activity, FileText, MessageSquare } from 'lucide-react';
import { clsx } from 'clsx';

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

function App() {
    const [activeServer, setActiveServer] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<'ssh' | 'rdp' | 'sftp' | 'status'>('ssh');
    const [isAddServerOpen, setIsAddServerOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [servers, setServers] = useState<any[]>([]);
    const [editingServer, setEditingServer] = useState<any>(null);
    const [isChatOpen, setIsChatOpen] = useState(true);
    const [statusTerminalMounted, setStatusTerminalMounted] = useState(false);

    // Terminal History Buffer (Ref to avoid re-renders)
    const terminalHistoryRef = useRef('');
    const terminalLineBufferRef = useRef('');
    const [terminalIssues, setTerminalIssues] = useState<TerminalIssue[]>([]);
    const recentTerminalIssueKeysRef = useRef<Map<string, number>>(new Map());
    const lastTerminalIssueIdRef = useRef<string | null>(null);

    const recordTerminalIssue = (type: TerminalIssueType, message: string, details?: string) => {
        const normalizedMessage = message.trim();
        const normalizedDetails = details?.trim();
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
        const trimmedDetails = detailsLine.trim();
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

        const rawIssueMatch = cleanOutput.match(/(?:^|\n)(.*?(?:permission denied|command not found|not recognized|no such file or directory|cannot find path|access denied|refused|timed out|fatal|error:|exception|authentication failed|auth failed|forbidden).*)/i);
        if (rawIssueMatch?.[1]) {
            recordTerminalIssue('error', rawIssueMatch[1]);
        }
    };

    const fetchServers = async () => {
        try {
            const res = await fetch('http://localhost:3001/api/servers');
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
        setIsChatOpen(server.type !== 's3');
        setStatusTerminalMounted(false);
        setActiveTab((server.type === 'ftp' || server.type === 's3') ? 'sftp' : 'ssh');
    };

    const handleEditServer = (server: any) => {
        setEditingServer(server);
        setIsAddServerOpen(true);
    };

    const handleCloseModal = () => {
        setIsAddServerOpen(false);
        setEditingServer(null);
    };

    const handleOsDetected = (osName: string) => {
        setActiveServer((prev: any) => ({ ...prev, osDetail: osName }));
        if (activeServer?.id) {
            fetch(`http://localhost:3001/api/servers/${activeServer.id}/os`, {
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

    // Detect Electron
    const isElectron = navigator.userAgent.toLowerCase().includes(' electron/');

    const statusCommand = isWindows
        ? "powershell -Command \"while ($true) { $s = '--- SYSTEM STATUS ---' + [Environment]::NewLine; $os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor; $mem = [math]::Round($os.FreePhysicalMemory / 1024, 2); $tot = [math]::Round($os.TotalVisibleMemorySize / 1024, 2); $s += 'OS: ' + $os.Caption + [Environment]::NewLine; $s += 'Uptime: ' + ((Get-Date) - $os.LastBootUpTime).ToString('dd\\.hh\\:mm\\:ss') + [Environment]::NewLine; $s += 'CPU: ' + $cpu.LoadPercentage + '%' + [Environment]::NewLine; $s += 'Memory: ' + $mem + 'MB Free / ' + $tot + 'MB Total' + [Environment]::NewLine + [Environment]::NewLine; $s += '--- DISK USAGE ---' + [Environment]::NewLine; $s += (Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[math]::Round($_.Used/1GB,2)}}, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,2)}} | Format-Table -AutoSize | Out-String); $s += '--- TOP PROCESSES ---' + [Environment]::NewLine; $s += (Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, Id, WorkingSet | Format-Table -AutoSize | Out-String); Clear-Host; Write-Host $s; Start-Sleep -Seconds 2 }\""
        : "if command -v htop &> /dev/null; then htop; else top; fi";

    return (
        <div className={clsx(
            "h-screen w-screen bg-black text-zinc-300 grid overflow-hidden font-sans transition-all duration-300 ease-in-out",
            shouldShowChat ? "grid-cols-[260px_1fr_380px]" : "grid-cols-[260px_1fr_0px]"
        )}>
            {/* Column 1: Sidebar */}
            <aside className="border-r border-zinc-800 bg-zinc-900/50 flex flex-col h-full overflow-hidden min-h-0">
                <Sidebar
                    servers={servers}
                    onSelectServer={handleSelectServer}
                    activeServerId={activeServer?.id}
                    onAddServer={() => setIsAddServerOpen(true)}
                    onEditServer={handleEditServer}
                    onOpenSettings={() => setIsSettingsOpen(true)}
                />
            </aside>

            {/* Column 2: Workspace (Terminal/RDP) */}
            <main className="flex flex-col min-w-0 bg-black relative h-full overflow-hidden min-h-0">
                {/* Workspace Header */}
                <header
                    className={clsx(
                        "h-10 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-900/30 shrink-0",
                        isElectron && !isChatOpen && "pr-36" // Add padding only if Chat is closed
                    )}
                    style={{ WebkitAppRegion: isElectron ? 'drag' : undefined } as any}
                >
                    <div className="flex items-center gap-4 min-w-0 flex-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        {activeServer ? (
                            <div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden">
                                <span className={clsx("w-2 h-2 rounded-full shadow-sm shrink-0", "bg-emerald-500 shadow-emerald-500/50")}></span>
                                <span className="font-medium text-zinc-100 truncate max-w-[150px] md:max-w-xs">{activeServer.name}</span>
                                <span className="text-zinc-600 font-mono text-xs truncate shrink-0">({activeServer.ip})</span>
                            </div>
                        ) : (
                            <span className="text-zinc-500 text-sm italic">No connection selected</span>
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
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-zinc-800",
                                            activeTab === 'ssh' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                                        )}
                                    >
                                        <TerminalIcon className="w-3.5 h-3.5" />
                                        {activeServer.type === 'ftp' ? "Terminal" : (isWindows ? "CMD / PowerShell" : "SSH")}
                                    </button>
                                )}

                                <button
                                    onClick={() => setActiveTab('sftp')}
                                    className={clsx(
                                        "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-zinc-800",
                                        activeTab === 'sftp' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                                    )}
                                >
                                    <FileText className="w-3.5 h-3.5" />
                                    Files
                                </button>

                                {activeServer.type !== 'ftp' && activeServer.type !== 's3' && (
                                    <button
                                        onClick={() => {
                                            setStatusTerminalMounted(true);
                                            setActiveTab('status');
                                        }}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-zinc-800",
                                            activeTab === 'status' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                                        )}
                                    >
                                        <Activity className="w-3.5 h-3.5" />
                                        Status
                                    </button>
                                )}

                                {isWindows && (
                                    <button
                                        onClick={() => setActiveTab('rdp')}
                                        className={clsx(
                                            "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-zinc-800",
                                            activeTab === 'rdp' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                                        )}
                                    >
                                        <Monitor className="w-3.5 h-3.5" />
                                        RDP
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Chat Toggle Button */}
                        <button
                            onClick={() => {
                                if (chatEnabled) {
                                    setIsChatOpen(!isChatOpen);
                                }
                            }}
                            disabled={!chatEnabled}
                            className={clsx(
                                "p-1.5 rounded transition-colors",
                                chatEnabled
                                    ? (isChatOpen ? "text-teal-500 hover:bg-zinc-800" : "text-zinc-500 hover:bg-zinc-800")
                                    : "text-zinc-700 opacity-50 cursor-not-allowed"
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
                </header>

                {/* Workspace Content */}
                <div className="flex-1 relative bg-[#0a0a0a] min-h-0 overflow-hidden">
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

                            {statusTerminalMounted && activeServer.type !== 'ftp' && activeServer.type !== 's3' && (
                                <div className={clsx("absolute inset-0", activeTab === 'status' ? "block" : "hidden")}>
                                    <TerminalComponent
                                        key={`terminal-status-${activeServer.id}`}
                                        server={activeServer}
                                        initialCommand={statusCommand}
                                        onOutput={handleTerminalOutput}
                                        isActive={activeTab === 'status'}
                                    />
                                </div>
                            )}

                            {isWindows && (
                                <div className={clsx("absolute inset-0 bg-[#0a0a0a]", activeTab === 'rdp' ? "block" : "hidden")}>
                                    <RdpComponent server={activeServer} />
                                </div>
                            )}

                            <div className={clsx("absolute inset-0 bg-[#0a0a0a]", activeTab === 'sftp' ? "block" : "hidden")}>
                                <FileExplorer server={activeServer} isVisible={activeTab === 'sftp'} />
                            </div>
                        </>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
                            <div className="text-center">
                                <TerminalIcon className="w-16 h-16 mx-auto mb-4 opacity-10" />
                                <p className="text-sm">Select a server to begin</p>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            {/* Column 3: AI Chat */}
            {chatEnabled && (
                <aside
                    className={clsx(
                        "border-l border-zinc-800 bg-zinc-900/30 flex flex-col h-full overflow-hidden min-h-0 transition-all duration-300 relative",
                        isChatOpen ? "w-[380px]" : "w-0 border-l-0"
                    )}
                >
                    <div className="w-[380px] h-full absolute right-0 top-0 bottom-0">
                        <Chat
                            activeServer={activeServer}
                            terminalHistory={terminalHistoryRef}
                            terminalIssues={terminalIssues}
                        />
                    </div>
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
