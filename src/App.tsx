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

function App() {
  const [activeServer, setActiveServer] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'ssh' | 'rdp' | 'sftp' | 'status'>('ssh');
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [servers, setServers] = useState<any[]>([]);
  const [editingServer, setEditingServer] = useState<any>(null);
  const [isChatOpen, setIsChatOpen] = useState(true);
  
  // Terminal History Buffer (Ref to avoid re-renders)
  const terminalHistoryRef = useRef('');

  const handleTerminalOutput = (data: string) => {
      terminalHistoryRef.current += data;
      // Keep last 10,000 chars to avoid memory issues but have enough context
      if (terminalHistoryRef.current.length > 10000) {
          terminalHistoryRef.current = terminalHistoryRef.current.slice(-10000);
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
      setActiveTab('ssh');
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
  
  // Detect Electron
  const isElectron = navigator.userAgent.toLowerCase().includes(' electron/');

  const statusCommand = isWindows 
      ? "powershell -Command \"while ($true) { $s = '--- SYSTEM STATUS ---' + [Environment]::NewLine; $os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor; $mem = [math]::Round($os.FreePhysicalMemory / 1024, 2); $tot = [math]::Round($os.TotalVisibleMemorySize / 1024, 2); $s += 'OS: ' + $os.Caption + [Environment]::NewLine; $s += 'Uptime: ' + ((Get-Date) - $os.LastBootUpTime).ToString('dd\\.hh\\:mm\\:ss') + [Environment]::NewLine; $s += 'CPU: ' + $cpu.LoadPercentage + '%' + [Environment]::NewLine; $s += 'Memory: ' + $mem + 'MB Free / ' + $tot + 'MB Total' + [Environment]::NewLine + [Environment]::NewLine; $s += '--- DISK USAGE ---' + [Environment]::NewLine; $s += (Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[math]::Round($_.Used/1GB,2)}}, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,2)}} | Format-Table -AutoSize | Out-String); $s += '--- TOP PROCESSES ---' + [Environment]::NewLine; $s += (Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, Id, WorkingSet | Format-Table -AutoSize | Out-String); Clear-Host; Write-Host $s; Start-Sleep -Seconds 2 }\""
      : "if command -v htop &> /dev/null; then htop; else top; fi";

  return (
    <div className={clsx(
        "h-screen w-screen bg-black text-zinc-300 grid overflow-hidden font-sans transition-all duration-300 ease-in-out",
        isChatOpen ? "grid-cols-[260px_1fr_380px]" : "grid-cols-[260px_1fr]"
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
                        <button 
                            onClick={() => setActiveTab('ssh')}
                            className={clsx(
                                "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-zinc-800",
                                activeTab === 'ssh' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                            )}
                        >
                            <TerminalIcon className="w-3.5 h-3.5" />
                            {isWindows ? "CMD / PowerShell" : "SSH"}
                        </button>
                        
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

                        <button 
                            onClick={() => setActiveTab('status')}
                            className={clsx(
                                "px-4 h-full text-xs font-medium flex items-center gap-2 transition-colors border-l border-r border-zinc-800",
                                activeTab === 'status' ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                            )}
                        >
                            <Activity className="w-3.5 h-3.5" />
                            Status
                        </button>

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
                    onClick={() => setIsChatOpen(!isChatOpen)}
                    className={clsx(
                        "p-1.5 rounded hover:bg-zinc-800 transition-colors",
                        isChatOpen ? "text-teal-500" : "text-zinc-500"
                    )}
                    title={isChatOpen ? "Close Chat" : "Open Chat"}
                >
                    <MessageSquare className="w-4 h-4" />
                </button>
            </div>
        </header>

        {/* Workspace Content */}
        <div className="flex-1 relative bg-[#0a0a0a] min-h-0 overflow-hidden">
            {activeServer ? (
                <>
                    <div className={clsx("absolute inset-0", activeTab === 'ssh' ? "block" : "hidden")}>
                        <TerminalComponent 
                            server={activeServer} 
                            onOsDetected={handleOsDetected} 
                            onOutput={handleTerminalOutput}
                        />
                    </div>

                    <div className={clsx("absolute inset-0", activeTab === 'status' ? "block" : "hidden")}>
                        <TerminalComponent 
                            server={activeServer} 
                            initialCommand={statusCommand}
                        />
                    </div>

                    {isWindows && (
                        <div className={clsx("absolute inset-0 flex items-center justify-center bg-[#0a0a0a]", activeTab === 'rdp' ? "block" : "hidden")}>
                            <RdpComponent server={activeServer} />
                        </div>
                    )}

                    <div className={clsx("absolute inset-0 bg-[#0a0a0a]", activeTab === 'sftp' ? "block" : "hidden")}>
                        <FileExplorer server={activeServer} />
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
      {isChatOpen && (
        <aside className="border-l border-zinc-800 bg-zinc-900/30 flex flex-col h-full overflow-hidden min-h-0">
            <Chat activeServer={activeServer} terminalHistory={terminalHistoryRef} />
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
