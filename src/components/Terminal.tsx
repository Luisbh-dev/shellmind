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
}

const RECIPES = {
    linux: [
      { name: "Update System", cmd: "sudo apt update && sudo apt upgrade -y" },
      { name: "Docker Status", cmd: "docker ps -a" },
      { name: "Disk Usage", cmd: "df -h" },
      { name: "Memory Usage", cmd: "free -m" },
      { name: "Active Ports", cmd: "netstat -tulpn" },
      { name: "System Logs", cmd: "journalctl -xe | tail -n 50" }
    ],
    windows: [
      { name: "System Info", cmd: "systeminfo" },
      { name: "IP Config", cmd: "ipconfig /all" },
      { name: "Running Processes", cmd: "tasklist" },
      { name: "Network Stat", cmd: "netstat -an" }
    ]
};

export default function TerminalComponent({ server, onOsDetected, onOutput, initialCommand }: TerminalProps) {
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
    const socket = io('http://localhost:3001', {
        transports: ['websocket'],
        upgrade: false
    }); 
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

    socket.on("ssh-output", (data: string) => {
      term.write(data);
      if (onOutput) onOutput(data);

      if (initialCommand && !initialCommandSent.current) {
          initialCommandSent.current = true;
          setTimeout(() => {
              socket.emit("ssh-input", initialCommand + "\n");
          }, 800);
      }
    });

    socket.on("ssh-error", (err: string) => {
      term.writeln(`\r\nError: ${err}`);
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

    // Listen for external commands (e.g. from AI Chat)
    const handleExternalCommand = (e: CustomEvent) => {
        const cmd = e.detail;
        if (socketRef.current?.connected) {
            socketRef.current.emit("ssh-input", cmd + "\n"); // Append newline to execute
            term.focus();
        }
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("run-terminal-command" as any, handleExternalCommand as any);

    return () => {
      resizeObserver.disconnect();
      socket.disconnect();
      
      // Dispose addons first safely
      try { webglAddon.dispose(); } catch(e) {}
      try { fitAddon.dispose(); } catch(e) {}
      try { term.dispose(); } catch(e) {}

      window.removeEventListener("resize", handleResize);
      window.removeEventListener("run-terminal-command" as any, handleExternalCommand as any);
    };
  }, [server.id]); // Only reconnect if server ID changes, ignore OS updates

  const runSnippet = (cmd: string) => {
      if (socketRef.current?.connected) {
          socketRef.current.emit("ssh-input", cmd + "\n");
          xtermRef.current?.focus();
          setShowRecipes(false);
      }
  };

  const currentRecipes = server.type === 'windows' ? RECIPES.windows : RECIPES.linux;

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
            title="Command Recipes"
        >
            <Book className="w-4 h-4" />
        </button>

        {/* Recipes Menu */}
        {showRecipes && (
            <div className="absolute top-12 right-4 w-64 bg-[#0f1115] border border-zinc-800 rounded-lg shadow-2xl z-20 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
                    <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider">Quick Commands</span>
                    <button onClick={() => setShowRecipes(false)} className="text-zinc-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
                </div>
                <div className="p-1 max-h-[300px] overflow-y-auto">
                    {currentRecipes.map((recipe) => (
                        <button
                            key={recipe.name}
                            onClick={() => runSnippet(recipe.cmd)}
                            className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 group transition-colors"
                        >
                            <div className="text-xs font-medium text-zinc-300 group-hover:text-blue-400">{recipe.name}</div>
                            <div className="text-[10px] text-zinc-600 font-mono truncate">{recipe.cmd}</div>
                        </button>
                    ))}
                </div>
            </div>
        )}
    </div>
  );
}
