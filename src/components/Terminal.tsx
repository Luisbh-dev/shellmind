"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type IDecoration, type IMarker } from "xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "xterm/css/xterm.css";
import io, { Socket } from "socket.io-client";
import { Book, Bot, ChevronDown, ChevronUp, Copy, Eraser, Search, X } from "lucide-react";
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

type ErrorHighlight = {
    marker: IMarker;
    decoration?: IDecoration;
    disposeRender?: () => void;
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

const stripAnsiCodes = (value: string) => value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
const normalizeTerminalText = (value: string) => stripAnsiCodes(value).replace(/\r/g, "");

const ERROR_LINE_PATTERN =
    /(?:^|\b)(permission denied|command not found|not recognized|no such file or directory|cannot find path|access denied|refused|timed out|fatal|error:|exception|authentication failed|auth failed|forbidden|unable to find package provider|provider .* not found|could not find package provider|the term .* is not recognized|cannot stat|cannot open|operation not permitted|broken pipe|segmentation fault|bad file descriptor|failed)\b/i;

const looksLikeErrorLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\s*(error|fatal|exception)\b/i.test(trimmed)) return true;
    if (/^Error:\s+/i.test(trimmed)) return true;
    return ERROR_LINE_PATTERN.test(trimmed);
};

const normalizeUrlForOpen = (text: string) => {
    if (/^www\./i.test(text)) {
        return `https://${text}`;
    }

    return text;
};

export default function TerminalComponent({ server, onOsDetected, onOutput, initialCommand, isActive = true }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const toolbarNoticeTimerRef = useRef<number | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStats, setSearchStats] = useState({ index: -1, count: 0 });
  const [toolbarNotice, setToolbarNotice] = useState("");
  const initialCommandSent = useRef(false);
  const showSearchRef = useRef(showSearch);
  const searchValueRef = useRef(searchValue);
  const errorHighlightsRef = useRef<ErrorHighlight[]>([]);

  useEffect(() => {
      showSearchRef.current = showSearch;
  }, [showSearch]);

  useEffect(() => {
      searchValueRef.current = searchValue;
  }, [searchValue]);

  useEffect(() => {
      return () => {
          if (toolbarNoticeTimerRef.current) {
              window.clearTimeout(toolbarNoticeTimerRef.current);
              toolbarNoticeTimerRef.current = null;
          }
      };
  }, []);

  const searchOptions = {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      decorations: {
          matchBackground: "#22314a",
          matchBorder: "#60a5fa",
          matchOverviewRuler: "#60a5fa",
          activeMatchBackground: "#1d4ed8",
          activeMatchBorder: "#93c5fd",
          activeMatchColorOverviewRuler: "#93c5fd"
      }
  };

  const clearSearch = () => {
      searchAddonRef.current?.clearDecorations();
      setSearchStats({ index: -1, count: 0 });
  };

  const showNotice = (message: string) => {
      setToolbarNotice(message);

      if (toolbarNoticeTimerRef.current) {
          window.clearTimeout(toolbarNoticeTimerRef.current);
      }

      toolbarNoticeTimerRef.current = window.setTimeout(() => {
          setToolbarNotice("");
          toolbarNoticeTimerRef.current = null;
      }, 2200);
  };

  const clearTerminalScreen = () => {
      xtermRef.current?.clear();
      clearSearch();
      xtermRef.current?.focus();
      showNotice("Screen cleared");
  };

  const getTerminalSnapshot = (maxLines = 140, maxChars = 6000) => {
      const term = xtermRef.current;
      if (!term) return "";

      const buffer = term.buffer.active;
      const startLine = Math.max(0, buffer.length - maxLines);
      const lines: string[] = [];

      for (let i = startLine; i < buffer.length; i += 1) {
          const line = buffer.getLine(i);
          if (!line) continue;
          lines.push(line.translateToString(true));
      }

      const snapshot = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!snapshot) return "";

      return snapshot.length > maxChars ? snapshot.slice(-maxChars) : snapshot;
  };

  const copyTerminalSnapshot = async () => {
      const snapshot = getTerminalSnapshot();
      if (!snapshot) {
          showNotice("No terminal output yet");
          return;
      }

      try {
          await navigator.clipboard.writeText(snapshot);
          showNotice("Recent output copied");
      } catch (error) {
          console.warn("Failed to copy terminal output", error);
          showNotice("Copy failed");
      }
  };

  const askAiAboutTerminal = () => {
      const snapshot = getTerminalSnapshot();
      if (!snapshot) {
          showNotice("No terminal output yet");
          return;
      }

      window.dispatchEvent(new CustomEvent("terminal-chat-prompt", {
          detail: {
              prompt: "Analyze the recent terminal output and suggest the safest next step."
          }
      }));
      showNotice("Prompt sent to AI");
  };

  const openSearchPanel = () => {
      setShowRecipes(false);
      setShowSearch(true);
      if (searchValueRef.current.trim()) {
          window.requestAnimationFrame(() => runSearch("next", searchValueRef.current));
      }
      window.requestAnimationFrame(() => xtermRef.current?.focus());
  };

  const closeSearchPanel = () => {
      setShowSearch(false);
      clearSearch();
  };

  const disposeErrorHighlight = (highlight: ErrorHighlight) => {
      try {
          highlight.disposeRender?.();
      } catch (error) {
          console.warn("Failed to dispose terminal error action", error);
      }

      try {
          highlight.decoration?.dispose();
      } catch (error) {
          console.warn("Failed to dispose terminal error decoration", error);
      }

      try {
          highlight.marker.dispose();
      } catch (error) {
          console.warn("Failed to dispose terminal error marker", error);
      }
  };

  const clearErrorHighlights = () => {
      errorHighlightsRef.current.forEach(disposeErrorHighlight);
      errorHighlightsRef.current = [];
  };

  const addErrorHighlight = (term: XTerm, cursorYOffset: number) => {
      const marker = term.registerMarker(cursorYOffset);
      if (!marker) return;

      const highlight: ErrorHighlight = { marker };
      errorHighlightsRef.current.push(highlight);

      const decoration = term.registerDecoration({
          marker,
          anchor: "left",
          x: 0,
          width: Math.max(term.cols, 1),
          height: 1,
          backgroundColor: "#3b1a1e",
          foregroundColor: "#fecaca",
          layer: "bottom",
          overviewRulerOptions: {
              color: "#ef4444",
              position: "right"
          }
      });

      if (!decoration) {
          errorHighlightsRef.current.pop();
          marker.dispose();
          return;
      }

      highlight.decoration = decoration;

      decoration.onRender(() => {
          if (!decoration.element) return;

          decoration.element.style.position = "relative";
          decoration.element.style.display = "flex";
          decoration.element.style.alignItems = "center";
          decoration.element.style.pointerEvents = "auto";
          decoration.element.style.boxShadow = "inset 3px 0 0 #f87171";
          decoration.element.style.borderRadius = "3px";

          if (decoration.element.querySelector("[data-error-action='true']")) {
              return;
          }

          const actionButton = document.createElement("button");
          actionButton.type = "button";
          actionButton.dataset.errorAction = "true";
          actionButton.title = "Fix this SSH issue";
          actionButton.textContent = "⚡";
          actionButton.style.position = "absolute";
          actionButton.style.left = "4px";
          actionButton.style.top = "50%";
          actionButton.style.transform = "translateY(-50%)";
          actionButton.style.width = "18px";
          actionButton.style.height = "18px";
          actionButton.style.border = "1px solid rgba(248, 113, 113, 0.45)";
          actionButton.style.borderRadius = "9999px";
          actionButton.style.background = "rgba(127, 29, 29, 0.95)";
          actionButton.style.color = "#fecaca";
          actionButton.style.fontSize = "11px";
          actionButton.style.lineHeight = "1";
          actionButton.style.padding = "0";
          actionButton.style.display = "flex";
          actionButton.style.alignItems = "center";
          actionButton.style.justifyContent = "center";
          actionButton.style.cursor = "pointer";
          actionButton.style.boxShadow = "0 0 0 1px rgba(0, 0, 0, 0.25)";

          const handleActionClick = (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              window.dispatchEvent(new CustomEvent("terminal-issue-action", { detail: { action: "fix" } }));
          };

          actionButton.addEventListener("click", handleActionClick);
          decoration.element.appendChild(actionButton);

          highlight.disposeRender = () => {
              actionButton.removeEventListener("click", handleActionClick);
              actionButton.remove();
          };
      });

      marker.onDispose(() => {
          highlight.decoration?.dispose();
          errorHighlightsRef.current = errorHighlightsRef.current.filter((item) => item.marker !== marker);
      });

      while (errorHighlightsRef.current.length > 14) {
          const oldest = errorHighlightsRef.current.shift();
          if (oldest) {
              disposeErrorHighlight(oldest);
          }
      }
  };

  const highlightErrorLines = (term: XTerm, data: string, force = false) => {
      const normalized = normalizeTerminalText(data);
      if (!normalized.trim()) return;

      const endsWithNewline = /\n\s*$/.test(normalized);
      if (!force && !endsWithNewline) return;

      const lines = normalized.split(/\n/).map((line) => line.trimEnd());
      const lastVisibleLineIndex = endsWithNewline
          ? Math.max(lines.length - 2, 0)
          : Math.max(lines.length - 1, 0);
      const matchedIndexes = lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => looksLikeErrorLine(line))
          .map(({ index }) => index);

      if (!matchedIndexes.length) return;

      matchedIndexes.forEach((lineIndex) => {
          const cursorYOffset = lineIndex - lastVisibleLineIndex - (endsWithNewline ? 1 : 0);
          addErrorHighlight(term, cursorYOffset);
      });
  };

  const runSearch = (direction: "next" | "prev" = "next", termOverride?: string) => {
      const term = (termOverride ?? searchValue).trim();
      const addon = searchAddonRef.current;
      if (!addon) return;

      if (!term) {
          clearSearch();
          return;
      }

      const found = direction === "prev"
          ? addon.findPrevious(term, searchOptions)
          : addon.findNext(term, searchOptions);

      if (!found) {
          setSearchStats({ index: -1, count: 0 });
      }
  };

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

    const searchAddon = new SearchAddon({ highlightLimit: 1200 });
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const searchResultsDisposable = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        setSearchStats({ index: resultIndex, count: resultCount });
    });

    const webLinksAddon = new WebLinksAddon((event, uri) => {
        event.preventDefault();
        event.stopPropagation();

        try {
            const normalized = normalizeUrlForOpen(uri);
            const parsed = new URL(normalized);
            if (!/^https?:$/.test(parsed.protocol)) return;
            window.open(parsed.toString(), "_blank", "noopener,noreferrer");
        } catch (error) {
            console.warn("Failed to open terminal link", error);
        }
    }, {
        urlRegex: /(?:https?:\/\/|www\.)[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/
    });
    term.loadAddon(webLinksAddon);
    
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

    term.attachCustomKeyEventHandler((event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            openSearchPanel();
            return false;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
            event.preventDefault();
            clearTerminalScreen();
            return false;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && showSearchRef.current) {
            event.preventDefault();
            setSearchValue("");
            clearSearch();
            xtermRef.current?.focus();
            return false;
        }

        if (event.key === "Escape" && showSearchRef.current) {
            event.preventDefault();
            closeSearchPanel();
            return false;
        }

        return true;
    });

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

    const emitTerminalOutput = (data: string, forceHighlight = false) => {
      term.write(data, () => {
        highlightErrorLines(term, data, forceHighlight);
      });
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
      emitTerminalOutput(message, true);
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
      searchResultsDisposable.dispose();
      searchAddonRef.current = null;
      clearErrorHighlights();
      
      // Dispose addons first safely
      try { webglAddon.dispose(); } catch(e) {}
      try { fitAddon.dispose(); } catch(e) {}
      try { searchAddon.dispose(); } catch(e) {}
      try { webLinksAddon.dispose(); } catch(e) {}
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

        <div className="absolute top-2 right-4 flex flex-col items-end gap-2 z-10">
            <div className="flex items-center gap-2">
                <button
                    onClick={copyTerminalSnapshot}
                    className="p-2 rounded-md backdrop-blur-sm transition-all shadow-lg border bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
                    title="Copy recent terminal output"
                >
                    <Copy className="w-4 h-4" />
                </button>
                <button
                    onClick={askAiAboutTerminal}
                    className="p-2 rounded-md backdrop-blur-sm transition-all shadow-lg border bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
                    title="Ask AI about recent output"
                >
                    <Bot className="w-4 h-4" />
                </button>
                <button
                    onClick={clearTerminalScreen}
                    className="p-2 rounded-md backdrop-blur-sm transition-all shadow-lg border bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
                    title="Clear terminal"
                >
                    <Eraser className="w-4 h-4" />
                </button>
            </div>
            <div className="flex items-center gap-2">
                <button
                    onClick={() => {
                        openSearchPanel();
                    }}
                    className={clsx(
                        "p-2 rounded-md backdrop-blur-sm transition-all shadow-lg border",
                        showSearch
                            ? "bg-blue-600 text-white border-blue-500"
                            : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
                    )}
                    title="Search terminal"
                >
                    <Search className="w-4 h-4" />
                </button>
                <button 
                    onClick={() => {
                        setShowSearch(false);
                        clearSearch();
                        setShowRecipes(!showRecipes);
                    }}
                    className={clsx(
                        "p-2 rounded-md backdrop-blur-sm transition-all shadow-lg border",
                        showRecipes 
                            ? "bg-blue-600 text-white border-blue-500" 
                            : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200"
                    )}
                    title="AI Hints"
                >
                    <Book className="w-4 h-4" />
                </button>
            </div>
        </div>

        {toolbarNotice && (
            <div className="absolute top-12 right-4 rounded border border-zinc-700 bg-black/80 px-3 py-1.5 text-[11px] text-zinc-300 shadow-lg z-20">
                {toolbarNotice}
            </div>
        )}

        {showSearch && (
            <div className="absolute top-12 right-4 w-[20rem] bg-[#0f1115] border border-zinc-800 rounded-lg shadow-2xl z-20 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
                    <div className="min-w-0">
                        <span className="block text-xs font-bold text-zinc-300 uppercase tracking-wider">Search Terminal</span>
                        <span className="block text-[10px] text-zinc-500 mt-0.5">Ctrl+F to open, Esc to close</span>
                    </div>
                    <button
                        onClick={() => {
                            setShowSearch(false);
                            clearSearch();
                        }}
                        className="text-zinc-500 hover:text-white"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
                <div className="p-3 space-y-2">
                    <input
                        autoFocus
                        value={searchValue}
                        onChange={(e) => {
                            const nextValue = e.target.value;
                            setSearchValue(nextValue);
                            window.requestAnimationFrame(() => runSearch("next", nextValue));
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && e.shiftKey) {
                                e.preventDefault();
                                runSearch("prev");
                            } else if (e.key === "Enter") {
                                e.preventDefault();
                                runSearch("next");
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                closeSearchPanel();
                            }
                        }}
                        placeholder="Find text in terminal..."
                        className="w-full rounded border border-zinc-700 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                    />
                    <div className="flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                        <span className="max-w-[11rem]">
                            {searchValue.trim()
                                ? (searchStats.count > 0
                                    ? `${searchStats.index >= 0 ? searchStats.index + 1 : 0}/${searchStats.count} matches`
                                    : "No matches")
                                : "Type to search the buffer"}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="hidden sm:inline text-[10px] text-zinc-600">Ctrl+L clears, Ctrl+K clears search</span>
                            <div className="flex items-center gap-1">
                            <button
                                onClick={() => runSearch("prev")}
                                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                                title="Previous match"
                            >
                                <ChevronUp className="w-3 h-3" />
                            </button>
                            <button
                                onClick={() => runSearch("next")}
                                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                                title="Next match"
                            >
                                <ChevronDown className="w-3 h-3" />
                            </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

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
