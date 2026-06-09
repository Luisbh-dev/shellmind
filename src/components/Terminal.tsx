"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type IDecoration, type IMarker } from "xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "xterm/css/xterm.css";
import io, { Socket } from "socket.io-client";
import {
    Book, Bot, ChevronDown, ChevronUp, ClipboardPaste, Copy, Eraser, History,
    MousePointerClick, Play, RotateCw, Search, Star, TextSelect, X
} from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/IconButton";
import { StatusDot, statusLabel, type ConnState } from "@/components/ui/StatusDot";
import { useToast } from "@/components/ui/Toast";
import { SOCKET_URL } from "@/config";

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

type CommandHistoryEntry = {
    id: string;
    command: string;
    timestamp: number;
    source: "typed" | "ai" | "hint";
};

type FavoriteCommandEntry = {
    id: string;
    command: string;
    addedAt: number;
};

type ContextMenuState = {
    x: number;
    y: number;
    hasSelection: boolean;
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

// Quick subcommands for scoped CLI consoles (keyed by cli_preset). The leading
// tool name is added automatically by the console, so these are bare subcommands.
const CLI_HINTS: Record<string, HintGroup[]> = {
    docker: [
        {
            title: "Containers & images",
            subtitle: "Everyday Docker checks.",
            items: [
                { title: "Running containers", description: "List active containers.", cmd: "ps" },
                { title: "All containers", description: "Include stopped ones.", cmd: "ps -a" },
                { title: "List images", description: "Local images.", cmd: "images" },
                { title: "Disk usage", description: "Space used by Docker.", cmd: "system df" }
            ]
        }
    ],
    kubectl: [
        {
            title: "Cluster basics",
            subtitle: "Inspect the current context.",
            items: [
                { title: "Pods", description: "Pods in the namespace.", cmd: "get pods" },
                { title: "Services", description: "List services.", cmd: "get svc" },
                { title: "Nodes", description: "Cluster nodes.", cmd: "get nodes" },
                { title: "Contexts", description: "Available contexts.", cmd: "config get-contexts" }
            ]
        }
    ],
    aws: [
        {
            title: "Account & storage",
            subtitle: "Common AWS lookups.",
            items: [
                { title: "Who am I", description: "Current identity.", cmd: "sts get-caller-identity" },
                { title: "List buckets", description: "S3 buckets.", cmd: "s3 ls" },
                { title: "EC2 instances", description: "Describe instances.", cmd: "ec2 describe-instances" }
            ]
        }
    ],
    azure: [
        {
            title: "Subscription",
            subtitle: "Common Azure lookups.",
            items: [
                { title: "Current account", description: "Active subscription.", cmd: "account show --output table" },
                { title: "Resource groups", description: "List groups.", cmd: "group list --output table" },
                { title: "Virtual machines", description: "List VMs.", cmd: "vm list --output table" }
            ]
        }
    ],
    gcloud: [
        {
            title: "Project & compute",
            subtitle: "Common gcloud lookups.",
            items: [
                { title: "Config", description: "Active config.", cmd: "config list" },
                { title: "Projects", description: "List projects.", cmd: "projects list" },
                { title: "Instances", description: "Compute instances.", cmd: "compute instances list" }
            ]
        }
    ]
};

const stripAnsiCodes = (value: string) => value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
const normalizeTerminalText = (value: string) => stripAnsiCodes(value).replace(/\r/g, "");
const COMMAND_HISTORY_LIMIT = 18;
const COMMAND_HISTORY_STORAGE_PREFIX = "shellmind-command-history:";
const FAVORITE_COMMAND_STORAGE_PREFIX = "shellmind-favorite-commands:";

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
  const commandBufferRef = useRef("");
  const toast = useToast();
  const [showRecipes, setShowRecipes] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStats, setSearchStats] = useState({ index: -1, count: 0 });
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>([]);
  const [favoriteCommands, setFavoriteCommands] = useState<FavoriteCommandEntry[]>([]);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [connError, setConnError] = useState<string>("");
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const initialCommandSent = useRef(false);
  const showSearchRef = useRef(showSearch);
  const searchValueRef = useRef(searchValue);
  const errorHighlightsRef = useRef<ErrorHighlight[]>([]);
  const connStateRef = useRef<ConnState>("connecting");
  const supportsCommandHistory = !initialCommand;
  const commandHistoryStorageKey = `${COMMAND_HISTORY_STORAGE_PREFIX}${server.id}`;
  const favoriteCommandsStorageKey = `${FAVORITE_COMMAND_STORAGE_PREFIX}${server.id}`;

  useEffect(() => {
      showSearchRef.current = showSearch;
  }, [showSearch]);

  useEffect(() => {
      searchValueRef.current = searchValue;
  }, [searchValue]);

  // Mirror connState into a ref so the long-lived key handler reads live state.
  useEffect(() => {
      connStateRef.current = connState;
  }, [connState]);

  // Broadcast the real connection state so App/Chat reflect it accurately.
  useEffect(() => {
      window.dispatchEvent(new CustomEvent("shellmind:connection", {
          detail: { serverId: server.id, state: connState, error: connError }
      }));
  }, [connState, connError, server.id]);

  useEffect(() => {
      setShowHistory(false);
      commandBufferRef.current = "";

      if (!supportsCommandHistory) {
          setCommandHistory([]);
          return;
      }

      try {
          const raw = window.localStorage.getItem(commandHistoryStorageKey);
          if (!raw) {
              setCommandHistory([]);
              return;
          }

          const parsed = JSON.parse(raw) as CommandHistoryEntry[];
          setCommandHistory(Array.isArray(parsed) ? parsed.slice(0, COMMAND_HISTORY_LIMIT) : []);
      } catch (error) {
          console.warn("Failed to load command history", error);
          setCommandHistory([]);
      }

      try {
          const rawFavorites = window.localStorage.getItem(favoriteCommandsStorageKey);
          if (!rawFavorites) {
              setFavoriteCommands([]);
              return;
          }

          const parsedFavorites = JSON.parse(rawFavorites) as FavoriteCommandEntry[];
          setFavoriteCommands(Array.isArray(parsedFavorites) ? parsedFavorites : []);
      } catch (error) {
          console.warn("Failed to load favorite commands", error);
          setFavoriteCommands([]);
      }
  }, [commandHistoryStorageKey, favoriteCommandsStorageKey, supportsCommandHistory]);

  useEffect(() => {
      return () => {
          if (toolbarNoticeTimerRef.current) {
              window.clearTimeout(toolbarNoticeTimerRef.current);
              toolbarNoticeTimerRef.current = null;
          }
      };
  }, []);

  // Close context menu on any global click / escape.
  useEffect(() => {
      if (!contextMenu) return;
      const close = () => setContextMenu(null);
      const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("keydown", onKey);
      return () => {
          window.removeEventListener("click", close);
          window.removeEventListener("contextmenu", close);
          window.removeEventListener("keydown", onKey);
      };
  }, [contextMenu]);

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

  const persistCommandHistory = (items: CommandHistoryEntry[]) => {
      if (!supportsCommandHistory) return;

      try {
          window.localStorage.setItem(commandHistoryStorageKey, JSON.stringify(items));
      } catch (error) {
          console.warn("Failed to persist command history", error);
      }
  };

  const persistFavoriteCommands = (items: FavoriteCommandEntry[]) => {
      if (!supportsCommandHistory) return;

      try {
          window.localStorage.setItem(favoriteCommandsStorageKey, JSON.stringify(items));
      } catch (error) {
          console.warn("Failed to persist favorite commands", error);
      }
  };

  const saveCommandToHistory = (command: string, source: CommandHistoryEntry["source"]) => {
      if (!supportsCommandHistory) return;

      const normalized = command
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" && ")
          .trim();

      if (!normalized) return;

      setCommandHistory((prev) => {
          const next: CommandHistoryEntry[] = [
              {
                  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  command: normalized,
                  timestamp: Date.now(),
                  source
              },
              ...prev.filter((entry) => entry.command !== normalized)
          ].slice(0, COMMAND_HISTORY_LIMIT);

          persistCommandHistory(next);
          return next;
      });
  };

  const isFavoriteCommand = (command: string) =>
      favoriteCommands.some((entry) => entry.command === command);

  const toggleFavoriteCommand = (command: string) => {
      if (!supportsCommandHistory || !command.trim()) return;

      setFavoriteCommands((prev) => {
          const exists = prev.some((entry) => entry.command === command);
          const next = exists
              ? prev.filter((entry) => entry.command !== command)
              : [
                  {
                      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                      command,
                      addedAt: Date.now()
                  },
                  ...prev
                ];

          persistFavoriteCommands(next);
          showNotice(exists ? "Removed from favorites" : "Saved to favorites");
          return next;
      });
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

  // ---- Clipboard ---------------------------------------------------------
  const copySelection = async () => {
      const term = xtermRef.current;
      if (!term) return false;
      const selection = term.getSelection();
      if (!selection) {
          showNotice("Nothing selected");
          return false;
      }
      try {
          await navigator.clipboard.writeText(selection);
          showNotice("Copied selection");
          return true;
      } catch (error) {
          console.warn("Failed to copy selection", error);
          toast.error("Copy failed", "Clipboard access was blocked.");
          return false;
      }
  };

  const pasteFromClipboard = async () => {
      const term = xtermRef.current;
      if (!term) return;
      if (connStateRef.current !== "connected") {
          showNotice("Not connected");
          return;
      }
      try {
          const text = await navigator.clipboard.readText();
          if (text) {
              // term.paste() respects bracketed-paste mode when the shell enables it.
              term.paste(text);
          }
          term.focus();
      } catch (error) {
          console.warn("Failed to read clipboard", error);
          toast.error("Paste failed", "Clipboard access was blocked by the OS.");
      }
  };

  const selectAll = () => {
      xtermRef.current?.selectAll();
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

  const sendCommandToTerminal = (command: string, source?: CommandHistoryEntry["source"]) => {
      if (!command || !socketRef.current?.connected) return;

      // Send each line as an Enter keypress (\r). This runs multi-line scripts
      // sequentially in any shell (PowerShell, cmd, bash) without relying on
      // "&&" chaining, which is invalid in Windows PowerShell 5.1.
      const payload = command.replace(/\r?\n/g, "\r").replace(/\r+$/, "") + "\r";
      socketRef.current.emit("ssh-input", payload);
      xtermRef.current?.focus();

      if (source) {
          saveCommandToHistory(command, source);
      }
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
          actionButton.textContent = "!";
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

    setConnState("connecting");
    setConnError("");

    // Initialize xterm
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      fontWeight: 400,
      fontWeightBold: 600,
      letterSpacing: 0,
      lineHeight: 1.25,
      scrollback: 5000, // Increased buffer
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: {
        background: "#0b0d11",
        foreground: "#e6e8ec",
        cursor: "#2dd4cb",
        cursorAccent: "#0b0d11",
        selectionBackground: "rgba(45,212,203,0.32)",
        black: "#1a1d23",
        brightBlack: "#3a4150",
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
        if (event.type !== "keydown") return true;

        const mod = event.ctrlKey || event.metaKey;

        // Paste: Ctrl/Cmd+V (and Ctrl+Shift+V).
        if (mod && event.code === "KeyV") {
            event.preventDefault();
            void pasteFromClipboard();
            return false;
        }

        // Copy: Cmd+C (macOS) or Ctrl+Shift+C.
        if ((event.metaKey && !event.ctrlKey && event.code === "KeyC") ||
            (event.ctrlKey && event.shiftKey && event.code === "KeyC")) {
            event.preventDefault();
            void copySelection();
            return false;
        }

        // Ctrl+C: copy if there is a selection, otherwise let the shell receive SIGINT.
        if (event.ctrlKey && !event.shiftKey && !event.metaKey && event.code === "KeyC") {
            const activeTerm = xtermRef.current;
            if (activeTerm && activeTerm.hasSelection()) {
                event.preventDefault();
                void copySelection().then((ok) => { if (ok) activeTerm.clearSelection(); });
                return false;
            }
            return true;
        }

        if (mod && !event.shiftKey && event.key.toLowerCase() === "f") {
            event.preventDefault();
            openSearchPanel();
            return false;
        }

        if (mod && !event.shiftKey && event.key.toLowerCase() === "l") {
            event.preventDefault();
            clearTerminalScreen();
            return false;
        }

        if (mod && event.key.toLowerCase() === "k" && showSearchRef.current) {
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
    const initObserveTimer = window.setTimeout(() => {
        // Bail if this terminal was disposed/replaced before the timer fired.
        if (xtermRef.current !== term) return;
        if (terminalRef.current) {
            resizeObserver.observe(terminalRef.current);
            try { fitAddon.fit(); } catch(e){}
        }
    }, 200);

    term.writeln(`\x1b[2mConnecting to ${server.name} (${server.ip})...\x1b[0m`);

    // Initialize socket connection
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnState("connecting");

      // Determine port: for Windows use ssh_port, for Linux use standard port
      const portToUse = server.type === 'windows'
          ? (server.ssh_port || 22)
          : (server.port || 22);

      socket.emit("start-ssh", {
          host: server.ip,
          username: server.username,
          password: server.password,
          type: server.type,
          port: portToUse,
          // Local CLI session fields (ignored by remote connection types).
          command: server.command,
          cwd: server.cwd,
          initialCommand: server.initial_command,
          cli_preset: server.cli_preset,
          serverId: server.id
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

      // Fallback: real server output means the session is live, even if the
      // backend never emits "connection-ready" (e.g. SFTP init failed).
      setConnState((prev) => (prev === "connecting" ? "connected" : prev));

      if (initialCommand && !initialCommandSent.current) {
          initialCommandSent.current = true;
          setTimeout(() => {
              socket.emit("ssh-input", initialCommand + "\n");
          }, 800);
      }
    });

    socket.on("connection-ready", () => {
      setConnState("connected");
      setConnError("");
    });

    socket.on("ssh-error", (err: string) => {
      const message = `\r\n\x1b[31mError: ${err}\x1b[0m\r\n`;
      emitTerminalOutput(message, true);
      setConnState("error");
      setConnError(err || "Connection failed");
    });

    socket.on("ssh-closed", () => {
      setConnState((prev) => (prev === "error" ? prev : "disconnected"));
    });

    socket.on("disconnect", () => {
      setConnState((prev) => (prev === "error" ? prev : "disconnected"));
    });

    socket.on("os-detected", (os: string) => {
        if (onOsDetected) onOsDetected(os);
    });

    term.onData((data) => {
      if (supportsCommandHistory && !initialCommand && !data.includes("\u001b")) {
          for (const char of data) {
              if (char === "\r") {
                  const submitted = commandBufferRef.current.trim();
                  if (submitted) {
                      saveCommandToHistory(submitted, "typed");
                  }
                  commandBufferRef.current = "";
                  continue;
              }

              if (char === "\u007f" || char === "\b") {
                  commandBufferRef.current = commandBufferRef.current.slice(0, -1);
                  continue;
              }

              if (char === "\t") {
                  commandBufferRef.current += " ";
                  continue;
              }

              if (char >= " ") {
                  commandBufferRef.current += char;
              }
          }
      }

      socket.emit("ssh-input", data);
    });

    const handleResize = () => {
      fitAddon.fit();
      socket.emit("resize", { cols: term.cols, rows: term.rows });
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.clearTimeout(initObserveTimer);
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
  }, [server.id, reconnectNonce]); // Reconnect on server change or manual reconnect

  useEffect(() => {
      if (!isActive) return;

      // Only the visible terminal should consume AI-run commands.
      const handleExternalCommand = (e: Event) => {
          const cmd = (e as CustomEvent<string>).detail;
          if (!cmd || typeof cmd !== "string") return;

          sendCommandToTerminal(cmd, supportsCommandHistory ? "ai" : undefined);
      };

      window.addEventListener("run-terminal-command", handleExternalCommand as EventListener);

      return () => {
          window.removeEventListener("run-terminal-command", handleExternalCommand as EventListener);
      };
  }, [isActive]);

  const runSnippet = (cmd: string) => {
      sendCommandToTerminal(cmd, supportsCommandHistory ? "hint" : undefined);
      setShowRecipes(false);
  };

  const rerunHistoryCommand = (entry: CommandHistoryEntry) => {
      sendCommandToTerminal(entry.command, supportsCommandHistory ? entry.source : undefined);
      setShowHistory(false);
      showNotice("Command re-run");
  };

  const rerunFavoriteCommand = (entry: FavoriteCommandEntry) => {
      sendCommandToTerminal(entry.command, supportsCommandHistory ? "hint" : undefined);
      setShowHistory(false);
      showNotice("Favorite command run");
  };

  const reconnect = () => {
      setConnState("connecting");
      setConnError("");
      setReconnectNonce((n) => n + 1);
  };

  const closeAllPanels = () => {
      setShowSearch(false);
      setShowHistory(false);
      setShowRecipes(false);
      clearSearch();
  };

  const handleContextMenu = (event: React.MouseEvent) => {
      event.preventDefault();
      const term = xtermRef.current;
      setContextMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: Boolean(term?.hasSelection())
      });
  };

  const handleMouseDown = (event: React.MouseEvent) => {
      // Middle-click paste (classic terminal convention).
      if (event.button === 1) {
          event.preventDefault();
          void pasteFromClipboard();
      }
  };

  const isLocalConn = server.type === "local";
  const currentHintGroups = isLocalConn
      ? (CLI_HINTS[server.cli_preset] || [])
      : (AI_HINTS[server.type] || AI_HINTS.linux);
  const hintsLabel = isLocalConn
      ? (server.cli_preset && server.cli_preset !== "shell" && server.cli_preset !== "custom" ? `${server.cli_preset} CLI` : "this shell")
      : (server.type === "windows" ? "Windows" : server.type === "ftp" ? "FTP" : "Linux");
  const isBusy = connState === "connecting";

  return (
        <div className="relative flex h-full w-full flex-col bg-[#0b0d11]">
            {/* Toolbar */}
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-ink-850/80 px-3 backdrop-blur">
                <div className="flex min-w-0 items-center gap-2">
                    <StatusDot state={connState} />
                    <span className={cn(
                        "text-[11px] font-medium",
                        connState === "connected" ? "text-emerald-300"
                            : connState === "error" ? "text-rose-300"
                            : connState === "connecting" ? "text-amber-300"
                            : "text-zinc-400"
                    )}>
                        {statusLabel(connState)}
                    </span>
                    {connError && connState === "error" && (
                        <span className="truncate text-[11px] text-zinc-400" title={connError}>· {connError}</span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <IconButton size="sm" label="Paste (Ctrl+V)" onClick={() => void pasteFromClipboard()}>
                        <ClipboardPaste className="h-4 w-4" />
                    </IconButton>
                    <IconButton size="sm" label="Copy selection (Ctrl+Shift+C)" onClick={() => void copySelection()}>
                        <Copy className="h-4 w-4" />
                    </IconButton>
                    <IconButton size="sm" label="Copy recent output" onClick={copyTerminalSnapshot}>
                        <TextSelect className="h-4 w-4" />
                    </IconButton>
                    <IconButton size="sm" label="Ask AI about recent output" onClick={askAiAboutTerminal}>
                        <Bot className="h-4 w-4" />
                    </IconButton>
                    <IconButton size="sm" label="Clear terminal (Ctrl+L)" onClick={clearTerminalScreen}>
                        <Eraser className="h-4 w-4" />
                    </IconButton>

                    <span className="mx-1 h-4 w-px bg-white/10" />

                    <IconButton
                        size="sm"
                        active={showSearch}
                        label="Search terminal (Ctrl+F)"
                        onClick={() => { setShowHistory(false); setShowRecipes(false); openSearchPanel(); }}
                    >
                        <Search className="h-4 w-4" />
                    </IconButton>
                    {supportsCommandHistory && (
                        <IconButton
                            size="sm"
                            active={showHistory}
                            label="Command history"
                            onClick={() => { setShowSearch(false); clearSearch(); setShowRecipes(false); setShowHistory(!showHistory); }}
                        >
                            <History className="h-4 w-4" />
                        </IconButton>
                    )}
                    {currentHintGroups.length > 0 && (
                        <IconButton
                            size="sm"
                            active={showRecipes}
                            label="Quick commands"
                            onClick={() => { setShowSearch(false); clearSearch(); setShowHistory(false); setShowRecipes(!showRecipes); }}
                        >
                            <Book className="h-4 w-4" />
                        </IconButton>
                    )}
                </div>
            </div>

            {/* Terminal surface */}
            <div className="relative min-h-0 flex-1">
                <div
                    ref={terminalRef}
                    onContextMenu={handleContextMenu}
                    onMouseDown={handleMouseDown}
                    className="h-full w-full overflow-hidden pl-2 pt-1"
                />

                {/* Disconnected / error overlay */}
                {(connState === "disconnected" || connState === "error") && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-900/70 backdrop-blur-sm animate-fade-in">
                        <div className="w-[300px] rounded-2xl border border-white/10 bg-ink-700 p-6 text-center shadow-panel">
                            <div className={cn(
                                "mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full",
                                connState === "error" ? "bg-rose-500/15 text-rose-400" : "bg-zinc-500/15 text-zinc-400"
                            )}>
                                <RotateCw className="h-5 w-5" />
                            </div>
                            <div className="text-sm font-semibold text-zinc-100">
                                {connState === "error" ? "Connection failed" : "Session ended"}
                            </div>
                            <div className="mt-1 text-xs text-zinc-400 break-words">
                                {connError || (connState === "error"
                                    ? "Unable to reach the server."
                                    : "The remote session was closed.")}
                            </div>
                            <button
                                onClick={reconnect}
                                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-ink-900 transition hover:bg-brand-400"
                            >
                                <RotateCw className="h-4 w-4" />
                                Reconnect
                            </button>
                        </div>
                    </div>
                )}

                {/* Connecting shade */}
                {isBusy && (
                    <div className="pointer-events-none absolute right-3 top-2 z-20 flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 animate-fade-in">
                        <RotateCw className="h-3.5 w-3.5 animate-spin" />
                        Connecting
                    </div>
                )}
            </div>

            {toolbarNotice && (
                <div className="pointer-events-none absolute left-1/2 top-12 z-50 -translate-x-1/2 rounded-lg border border-white/10 bg-ink-700/95 px-3 py-1.5 text-[11px] text-zinc-200 shadow-soft animate-fade-in">
                    {toolbarNotice}
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <div
                    className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-white/10 bg-ink-700/98 py-1 shadow-panel backdrop-blur animate-scale-in"
                    style={{
                        left: Math.min(contextMenu.x, window.innerWidth - 200),
                        top: Math.min(contextMenu.y, window.innerHeight - 200)
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <ContextItem
                        icon={<Copy className="h-4 w-4" />}
                        label="Copy"
                        shortcut="Ctrl+Shift+C"
                        disabled={!contextMenu.hasSelection}
                        onClick={() => { void copySelection(); setContextMenu(null); }}
                    />
                    <ContextItem
                        icon={<ClipboardPaste className="h-4 w-4" />}
                        label="Paste"
                        shortcut="Ctrl+V"
                        onClick={() => { void pasteFromClipboard(); setContextMenu(null); }}
                    />
                    <ContextItem
                        icon={<TextSelect className="h-4 w-4" />}
                        label="Select all"
                        onClick={() => { selectAll(); setContextMenu(null); }}
                    />
                    <div className="my-1 h-px bg-white/5" />
                    <ContextItem
                        icon={<MousePointerClick className="h-4 w-4" />}
                        label="Ask AI about output"
                        onClick={() => { askAiAboutTerminal(); setContextMenu(null); }}
                    />
                    <ContextItem
                        icon={<Eraser className="h-4 w-4" />}
                        label="Clear screen"
                        shortcut="Ctrl+L"
                        onClick={() => { clearTerminalScreen(); setContextMenu(null); }}
                    />
                </div>
            )}

        {showSearch && (
            <div className="absolute right-3 top-12 w-[20rem] overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-panel z-40 animate-slide-up">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                    <div className="min-w-0">
                        <span className="block text-xs font-bold text-zinc-200 uppercase tracking-wider">Search Terminal</span>
                        <span className="block text-[11px] text-zinc-400 mt-0.5">Ctrl+F to open, Esc to close</span>
                    </div>
                    <button
                        onClick={() => {
                            setShowSearch(false);
                            clearSearch();
                        }}
                        className="text-zinc-400 hover:text-white"
                    >
                        <X className="w-4 h-4" />
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
                        className="w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500/70"
                    />
                    <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-400">
                        <span className="max-w-[11rem]">
                            {searchValue.trim()
                                ? (searchStats.count > 0
                                    ? `${searchStats.index >= 0 ? searchStats.index + 1 : 0}/${searchStats.count} matches`
                                    : "No matches")
                                : "Type to search the buffer"}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="hidden sm:inline text-[11px] text-zinc-400">Ctrl+L clears, Ctrl+K clears search</span>
                            <div className="flex items-center gap-1">
                            <button
                                onClick={() => runSearch("prev")}
                                className="rounded-lg border border-white/10 px-2 py-1 text-zinc-300 hover:bg-white/5"
                                title="Previous match"
                            >
                                <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => runSearch("next")}
                                className="rounded-lg border border-white/10 px-2 py-1 text-zinc-300 hover:bg-white/5"
                                title="Next match"
                            >
                                <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {showHistory && supportsCommandHistory && (
            <div className="absolute right-3 top-12 w-[22rem] overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-panel z-40 animate-slide-up">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                    <div className="min-w-0">
                        <span className="block text-xs font-bold text-zinc-200 uppercase tracking-wider">Command History</span>
                        <span className="block text-[11px] text-zinc-400 mt-0.5">Recent commands for this server</span>
                    </div>
                    <button
                        onClick={() => setShowHistory(false)}
                        className="text-zinc-400 hover:text-white"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="max-h-[320px] overflow-y-auto scrollbar-thin p-2 space-y-1">
                    {favoriteCommands.length > 0 && (
                        <div className="space-y-1 pb-2 mb-2 border-b border-white/5">
                            <div className="px-1 text-[11px] uppercase tracking-wider text-zinc-500">Favorites</div>
                            {favoriteCommands.map((entry) => (
                                <div
                                    key={entry.id}
                                    className="rounded-lg border border-amber-900/40 bg-amber-500/5 px-3 py-2"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <button
                                            onClick={() => rerunFavoriteCommand(entry)}
                                            className="min-w-0 flex-1 text-left"
                                            title="Run this favorite command"
                                        >
                                            <div className="text-[11px] text-zinc-200 font-mono break-all">{entry.command}</div>
                                            <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-300/80">
                                                <Play className="w-3.5 h-3.5" />
                                                Run favorite
                                            </div>
                                        </button>
                                        <button
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                toggleFavoriteCommand(entry.command);
                                            }}
                                            className="rounded-lg border border-amber-900/40 px-2 py-1 text-amber-300 hover:bg-amber-500/10"
                                            title="Remove favorite"
                                        >
                                            <Star className="w-4 h-4 fill-current" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {commandHistory.length === 0 ? (
                        <div className="rounded-lg border border-white/5 bg-black/30 px-3 py-4 text-xs text-zinc-400">
                            Commands you run here will start appearing in this list.
                        </div>
                    ) : (
                        commandHistory.map((entry) => (
                            <div
                                key={entry.id}
                                className="rounded-lg border border-white/5 bg-black/30 px-3 py-2 hover:bg-white/5 hover:border-white/10 transition-colors"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <button
                                        onClick={() => rerunHistoryCommand(entry)}
                                        className="min-w-0 flex-1 text-left"
                                        title="Run this command again"
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] uppercase tracking-wider text-zinc-500">{entry.source}</span>
                                            <span className="text-[11px] text-zinc-500">
                                                {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                            </span>
                                        </div>
                                        <div className="mt-1 text-[11px] text-zinc-200 font-mono break-all">{entry.command}</div>
                                        <div className="mt-2 flex items-center gap-1 text-[11px] text-zinc-400">
                                            <Play className="w-3.5 h-3.5" />
                                            Run again
                                        </div>
                                    </button>
                                    <button
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            toggleFavoriteCommand(entry.command);
                                        }}
                                        className={cn(
                                            "rounded-lg border px-2 py-1 transition-colors",
                                            isFavoriteCommand(entry.command)
                                                ? "border-amber-900/40 text-amber-300 hover:bg-amber-500/10"
                                                : "border-white/10 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                                        )}
                                        title={isFavoriteCommand(entry.command) ? "Remove favorite" : "Save as favorite"}
                                    >
                                        <Star className={cn("w-4 h-4", isFavoriteCommand(entry.command) && "fill-current")} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        )}

        {/* Recipes Menu */}
        {showRecipes && (
            <div className="absolute right-3 top-12 w-[20rem] overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-panel z-40 animate-slide-up">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                    <div className="min-w-0">
                        <span className="block text-xs font-bold text-zinc-200 uppercase tracking-wider">{isLocalConn ? "Quick Commands" : "AI Hints"}</span>
                        <span className="block text-[11px] text-zinc-400 mt-0.5">Common commands for {hintsLabel}</span>
                    </div>
                    <button onClick={() => setShowRecipes(false)} className="text-zinc-400 hover:text-white"><X className="w-4 h-4" /></button>
                </div>
                <div className="p-2 max-h-[340px] overflow-y-auto scrollbar-thin space-y-3">
                    {currentHintGroups.map((group) => (
                        <div key={group.title} className="space-y-2">
                            <div>
                                <div className="text-[11px] font-semibold text-zinc-200">{group.title}</div>
                                <div className="text-[11px] text-zinc-400">{group.subtitle}</div>
                            </div>
                            <div className="space-y-1">
                                {group.items.map((hint) => (
                                    <button
                                        key={hint.title}
                                        onClick={() => runSnippet(hint.cmd)}
                                        className="w-full text-left rounded-lg border border-white/5 bg-black/30 px-3 py-2 hover:bg-white/5 hover:border-white/10 transition-colors group"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-xs font-medium text-zinc-200 group-hover:text-brand-300">{hint.title}</div>
                                                <div className="text-[11px] text-zinc-400 mt-0.5">{hint.description}</div>
                                            </div>
                                            <span className="text-[11px] text-zinc-500 font-mono shrink-0">Run</span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 font-mono truncate mt-1">{hint.cmd}</div>
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

function ContextItem({
    icon,
    label,
    shortcut,
    disabled,
    onClick
}: {
    icon: React.ReactNode;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors",
                disabled
                    ? "text-zinc-500 cursor-default"
                    : "text-zinc-300 hover:bg-brand-500/10 hover:text-brand-200"
            )}
        >
            <span className="shrink-0 text-zinc-400">{icon}</span>
            <span className="flex-1">{label}</span>
            {shortcut && <span className="text-[11px] text-zinc-500">{shortcut}</span>}
        </button>
    );
}
