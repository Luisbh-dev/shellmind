"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import "xterm/css/xterm.css";
import io, { Socket } from "socket.io-client";
import { Book, X } from "lucide-react";
import { clsx } from "clsx";

interface TerminalProps {
  server: any;
  onOsDetected?: (os: string) => void;
  onOutput?: (data: string) => void;
  initialCommand?: string;
  isActive?: boolean;
}

type Hint = {
    title: string;
    description: string;
    cmd: string;
};

type HintGroup = {
    title: string;
    subtitle: string;
    items: Hint[];
};

const AI_HINTS: Record<string, HintGroup[]> = {
    linux: [
        {
            title: "System health",
            subtitle: "Fast, low-risk checks for CPU, memory and uptime.",
            items: [
                { title: "Disk usage", description: "See what is filling the machine.", cmd: "df -h" },
                { title: "Memory usage", description: "Check RAM and swap pressure.", cmd: "free -m" },
                { title: "Uptime", description: "Confirm how long the server has been running.", cmd: "uptime" },
                { title: "Top processes", description: "Spot a process hogging resources.", cmd: "ps aux --sort=-%cpu | head -n 10" }
            ]
        },
        {
            title: "Services and logs",
            subtitle: "Good next steps when something feels off.",
            items: [
                { title: "Failed services", description: "Find units that are not healthy.", cmd: "systemctl --failed" },
                { title: "Recent logs", description: "Inspect the last errors from the journal.", cmd: "journalctl -xe | tail -n 50" },
                { title: "Listening ports", description: "Check what is exposed on the box.", cmd: "ss -tulpn" },
                { title: "Restart service", description: "Replace my-service with the service you need.", cmd: "sudo systemctl restart my-service" }
            ]
        }
    ],
    windows: [
        {
            title: "System health",
            subtitle: "Safe checks for Windows hosts.",
            items: [
                { title: "System info", description: "Get the machine summary.", cmd: "systeminfo" },
                { title: "Processes", description: "See running tasks and names.", cmd: "tasklist" },
                { title: "Memory status", description: "Inspect RAM pressure.", cmd: "powershell -Command \"Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize\"" },
                { title: "Network status", description: "Review active connections and ports.", cmd: "netstat -an" }
            ]
        },
        {
            title: "Troubleshooting",
            subtitle: "Useful follow-ups when a Windows command fails.",
            items: [
                { title: "IP config", description: "Check addresses and adapters.", cmd: "ipconfig /all" },
                { title: "Services", description: "Inspect service state.", cmd: "powershell -Command \"Get-Service | Sort-Object Status,Name\"" },
                { title: "Recent events", description: "Pull the latest system errors.", cmd: "powershell -Command \"Get-WinEvent -LogName System -MaxEvents 20 | Format-Table -AutoSize\"" },
                { title: "Top CPU", description: "See what is using the most CPU.", cmd: "powershell -Command \"Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,CPU,Id\"" }
            ]
        }
    ],
    ftp: [
        {
            title: "File navigation",
            subtitle: "FTP-friendly helpers for browsing the remote tree.",
            items: [
                { title: "Current path", description: "Confirm where you are now.", cmd: "pwd" },
                { title: "List files", description: "Inspect the current directory.", cmd: "ls" },
                { title: "Go up one level", description: "Move back to the parent folder.", cmd: "cd .." },
                { title: "Create folder", description: "Make a new directory.", cmd: "mkdir new-folder" }
            ]
        }
    ]
};

export default function TerminalComponent({ server, onOsDetected, onOutput, initialCommand, isActive = true }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);
  const initialCommandSent = useRef(false);

  useEffect(() => {
    initialCommandSent.current = false;
    if (!terminalRef.current || !server) return;

    // Initialize xterm
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000, // Increased buffer
      allowProposedApi: true,
      theme: {
        background: "#0f1115",
        foreground: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    // Load WebGL addon for performance
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(e => {
        webglAddon.dispose();
    });

    term.open(terminalRef.current);
    
    // Activate WebGL safely
    try {
        term.loadAddon(webglAddon);
    } catch (e) {
        console.warn("WebGL not supported, falling back to canvas/dom renderer", e);
    }

    xtermRef.current = term;

    // Use ResizeObserver to handle fitting robustly
    const resizeObserver = new ResizeObserver(() => {
        // Debounce resize to prevent flickering and errors
        window.requestAnimationFrame(() => {
            if (terminalRef.current && terminalRef.current.clientWidth > 0 && term.element) {
                try {
                    fitAddon.fit();
                    // Only send resize if connected
                    if (socketRef.current?.connected) {
                        socket.emit("resize", { 
                            cols: term.cols, 
                            rows: term.rows 
                        });
                    }
                } catch (e) {
                    // Ignore fit errors during initialization
                }
            }
        });
    });
    
    // Wait a bit before observing to let initial render happen
    setTimeout(() => {
        if (terminalRef.current) {
            resizeObserver.observe(terminalRef.current);
            try { fitAddon.fit(); } catch(e){}
        }
    }, 200);

    term.writeln(`Connecting to ${server.name} (${server.ip})...`);
    
    // Initialize socket connection
    const socket = io('http://localhost:3001'); 
    socketRef.current = socket;

    socket.on("connect", () => {
      term.writeln("Connected to backend relay.");
      
      // Determine port: for Windows use ssh_port, for Linux use standard port
      const portToUse = server.type === 'windows' 
          ? (server.ssh_port || 22)
          : (server.port || 22);

      socket.emit("start-ssh", { 
          host: server.ip, 
          username: server.username,
          password: server.password,
          type: server.type,
          port: portToUse
      });
      // Sync size immediately
      socket.emit("resize", { cols: term.cols, rows: term.rows });
    });

    const emitTerminalOutput = (data: string) => {
      term.write(data);
      if (onOutput) onOutput(data);
    };

    socket.on("ssh-output", (data: string) => {
      emitTerminalOutput(data);

      if (initialCommand && !initialCommandSent.current) {
          initialCommandSent.current = true;
          setTimeout(() => {
              socket.emit("ssh-input", initialCommand + "\n");
          }, 800);
      }
    });

    socket.on("ssh-error", (err: string) => {
      const message = `\r\nError: ${err}\r\n`;
      emitTerminalOutput(message);
    });

    socket.on("os-detected", (os: string) => {
        if (onOsDetected) onOsDetected(os);
    });

    term.onData((data) => {
      socket.emit("ssh-input", data);
    });

    const handleResize = () => {
      fitAddon.fit();
      socket.emit("resize", { cols: term.cols, rows: term.rows });
    };

    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      socket.disconnect();
      
      // Dispose addons first safely
      try { webglAddon.dispose(); } catch(e) {}
      try { fitAddon.dispose(); } catch(e) {}
      try { term.dispose(); } catch(e) {}

      window.removeEventListener("resize", handleResize);
    };
  }, [server.id]); // Only reconnect if server ID changes, ignore OS updates

  useEffect(() => {
      if (!isActive) return;

      // Only the visible terminal should consume AI-run commands.
      const handleExternalCommand = (e: Event) => {
          const cmd = (e as CustomEvent<string>).detail;
          if (!cmd || typeof cmd !== "string") return;

          if (socketRef.current?.connected) {
              socketRef.current.emit("ssh-input", cmd + "\n");
              xtermRef.current?.focus();
          }
      };

      window.addEventListener("run-terminal-command", handleExternalCommand as EventListener);

      return () => {
          window.removeEventListener("run-terminal-command", handleExternalCommand as EventListener);
      };
  }, [isActive]);

  const runSnippet = (cmd: string) => {
      if (socketRef.current?.connected) {
          socketRef.current.emit("ssh-input", cmd + "\n");
          xtermRef.current?.focus();
          setShowRecipes(false);
      }
  };

  const currentHintGroups = AI_HINTS[server.type] || AI_HINTS.linux;
  return (
    <div className="relative w-full h-full bg-[#0f1115]">
        <div ref={terminalRef} className="w-full h-full overflow-hidden pl-2" />
        
        {/* Recipe Button */}
        <button 
            onClick={() => setShowRecipes(!showRecipes)}
            className={clsx(
                "absolute top-2 right-4 p-2 rounded-md backdrop-blur-sm transition-all z-10 shadow-lg border",
                showRecipes 
                    ? "bg-blue-600 text-white border-blue-500" 
                    : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
            )}
            title="AI Hints"
        >
            <Book className="w-4 h-4" />
        </button>

        {/* Recipes Menu */}
        {showRecipes && (
            <div className="absolute top-12 right-4 w-[20rem] bg-[#0f1115] border border-zinc-800 rounded-lg shadow-2xl z-20 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
                    <div className="min-w-0">
                        <span className="block text-xs font-bold text-zinc-300 uppercase tracking-wider">AI Hints</span>
                        <span className="block text-[10px] text-zinc-500 mt-0.5">Context-aware suggestions for {server.type === "windows" ? "Windows" : server.type === "ftp" ? "FTP" : "Linux"}</span>
                    </div>
                    <button onClick={() => setShowRecipes(false)} className="text-zinc-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
                </div>
                <div className="p-2 max-h-[340px] overflow-y-auto space-y-3">
                    {currentHintGroups.map((group) => (
                        <div key={group.title} className="space-y-2">
                            <div>
                                <div className="text-[11px] font-semibold text-zinc-200">{group.title}</div>
                                <div className="text-[10px] text-zinc-500">{group.subtitle}</div>
                            </div>
                            <div className="space-y-1">
                                {group.items.map((hint) => (
                                    <button
                                        key={hint.title}
                                        onClick={() => runSnippet(hint.cmd)}
                                        className="w-full text-left rounded border border-zinc-800/70 bg-black/30 px-3 py-2 hover:bg-zinc-800 hover:border-zinc-700 transition-colors group"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-xs font-medium text-zinc-200 group-hover:text-blue-400">{hint.title}</div>
                                                <div className="text-[10px] text-zinc-500 mt-0.5">{hint.description}</div>
                                            </div>
                                            <span className="text-[10px] text-zinc-600 font-mono shrink-0">Run</span>
                                        </div>
                                        <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">{hint.cmd}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        )}
    </div>
  );
}
