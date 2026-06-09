"use client";

import { Terminal, Plus, Search, Server as ServerIcon, Edit2, Trash2, Codepen, Disc, Box, AppWindow, Folder, Settings, X, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { useState } from "react";
import { useToast, useConfirm } from "@/components/ui";
import { API_BASE } from "@/config";

interface SidebarProps {
    servers: any[];
    onSelectServer: (server: any) => void;
    activeServerId?: number;
    onAddServer: () => void;
    onEditServer: (server: any) => void;
    onOpenSettings: () => void;
    onServerDeleted?: (id: number) => void;
}

const GROUPS: { key: string; label: string; match: (type: string) => boolean }[] = [
    { key: "linux", label: "SSH / Linux", match: (t) => t === "linux" || (!["windows", "ftp", "s3", "local"].includes(t)) },
    { key: "windows", label: "Windows", match: (t) => t === "windows" },
    { key: "ftp", label: "FTP", match: (t) => t === "ftp" },
    { key: "s3", label: "Object Storage", match: (t) => t === "s3" },
    { key: "local", label: "Local / CLI", match: (t) => t === "local" }
];

export default function Sidebar({ servers, onSelectServer, activeServerId, onAddServer, onEditServer, onOpenSettings, onServerDeleted }: SidebarProps) {
    const [searchTerm, setSearchTerm] = useState("");
    const toast = useToast();
    const confirm = useConfirm();

    const filteredServers = servers.filter(server =>
        server.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (server.ip || "").includes(searchTerm)
    );

    const handleDelete = async (e: React.MouseEvent, server: any) => {
        e.stopPropagation();
        const ok = await confirm({
            title: "Delete connection",
            message: <>Remove <span className="text-zinc-200 font-medium">{server.name}</span> from your connections?</>,
            confirmLabel: "Delete",
            tone: "danger"
        });
        if (!ok) return;

        try {
            const res = await fetch(`${API_BASE}/api/servers/${server.id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("request failed");
            toast.success("Connection deleted", server.name);
            onServerDeleted?.(server.id);
        } catch (err) {
            console.error(err);
            toast.error("Could not delete connection");
        }
    };

    const renderServerIcon = (server: any) => {
        const os = (server.os_detail || "").toLowerCase();

        if (server.type === "local") return <TerminalSquare className="w-4 h-4 text-brand-400" />;
        if (server.type === "windows" || os.includes("windows")) return <AppWindow className="w-4 h-4 text-blue-400" />;
        if (server.type === "ftp") return <Folder className="w-4 h-4 text-amber-400" />;
        if (server.type === "s3") return <div className="w-4 h-4 flex items-center justify-center font-bold text-[8px] border border-brand-500 rounded text-brand-400">S3</div>;
        if (os.includes("ubuntu")) return <Codepen className="w-4 h-4 text-orange-500" />;
        if (os.includes("debian")) return <Disc className="w-4 h-4 text-rose-500" />;
        if (os.includes("centos") || os.includes("fedora") || os.includes("red hat")) return <Box className="w-4 h-4 text-blue-500" />;

        return <ServerIcon className="w-4 h-4 text-zinc-400" />;
    };

    const getOsBadgeColor = (os: string) => {
        const lower = os.toLowerCase();
        if (lower.includes("ubuntu")) return "bg-orange-900/30 text-orange-300 border-orange-800/50";
        if (lower.includes("debian")) return "bg-rose-900/30 text-rose-300 border-rose-800/50";
        if (lower.includes("centos")) return "bg-purple-900/30 text-purple-300 border-purple-800/50";
        if (lower.includes("windows")) return "bg-blue-900/30 text-blue-300 border-blue-800/50";
        if (lower.includes("ftp")) return "bg-amber-900/30 text-amber-300 border-amber-800/50";
        if (lower.includes("s3")) return "bg-brand-900/40 text-brand-300 border-brand-800/50";
        return "bg-white/5 text-zinc-400 border-white/10";
    };

    const renderRow = (server: any) => {
        const isActive = activeServerId === server.id;
        return (
            <div
                key={server.id}
                onClick={() => onSelectServer(server)}
                className={cn(
                    "group relative flex items-center gap-3 rounded-lg px-2.5 py-2 cursor-pointer border transition-all duration-150",
                    isActive
                        ? "bg-brand-500/10 border-brand-500/30"
                        : "border-transparent hover:bg-white/[0.04]"
                )}
            >
                {isActive && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand-400" />}
                <div className={cn("shrink-0", isActive ? "text-zinc-100" : "text-zinc-400")}>
                    {renderServerIcon(server)}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                        <span className={cn("truncate text-[13px] font-medium", isActive ? "text-white" : "text-zinc-200")}>{server.name}</span>
                        {(server.os_detail || server.type === "ftp" || server.type === "s3" || server.type === "local") && (
                            <span className={cn(
                                "shrink-0 rounded px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-wide border",
                                server.type === "local"
                                    ? "bg-brand-900/40 text-brand-300 border-brand-800/50"
                                    : getOsBadgeColor(server.os_detail || (server.type === "ftp" ? "ftp" : (server.type === "s3" ? "s3" : "")))
                            )}>
                                {server.type === "ftp" ? "FTP" : server.type === "s3" ? "S3" : server.type === "local" ? (server.cli_preset && server.cli_preset !== "shell" ? server.cli_preset : "CLI") : server.os_detail?.split(" ")[0]}
                            </span>
                        )}
                    </div>
                    <span className="truncate font-mono text-xs text-zinc-400">
                        {server.type === "local"
                            ? (server.cli_preset && !["shell", "custom"].includes(server.cli_preset)
                                ? `${server.cli_preset} console`
                                : (server.command || "system shell"))
                            : (server.ip || server.s3_bucket)}
                    </span>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={(e) => { e.stopPropagation(); onEditServer(server); }}
                        className="rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-brand-300"
                        title="Edit"
                    >
                        <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={(e) => handleDelete(e, server)}
                        className="rounded-md p-1.5 text-zinc-400 hover:bg-rose-500/15 hover:text-rose-400"
                        title="Delete"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
                <span className={cn(
                    "w-1.5 h-1.5 rounded-full shrink-0 transition-colors group-hover:opacity-0",
                    isActive ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-zinc-700"
                )} />
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full text-zinc-400 select-none">
            {/* Header */}
            <div
                className="h-10 flex items-center justify-between px-4 border-b border-white/5 bg-ink-850/70"
                style={{ WebkitAppRegion: "drag" } as any}
            >
                <div className="flex items-center gap-2 text-zinc-100" style={{ WebkitAppRegion: "no-drag" } as any}>
                    <div className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-500/20 text-brand-300">
                        <Terminal className="w-3.5 h-3.5" />
                    </div>
                    <span className="font-bold text-sm tracking-wide">ShellMind</span>
                </div>
                <button
                    onClick={onAddServer}
                    className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
                    style={{ WebkitAppRegion: "no-drag" } as any}
                    title="Add connection"
                >
                    <Plus className="w-4 h-4" />
                </button>
            </div>

            {/* Search */}
            <div className="p-3">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                    <input
                        type="text"
                        placeholder="Filter connections..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-ink-900/70 text-xs text-zinc-200 pl-8 pr-7 py-2 focus:outline-none focus:border-brand-500/50 transition-colors placeholder:text-zinc-500"
                    />
                    {searchTerm && (
                        <button onClick={() => setSearchTerm("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2 space-y-3">
                {filteredServers.length === 0 ? (
                    <div className="px-3 py-10 text-center">
                        <ServerIcon className="mx-auto mb-2 w-7 h-7 text-zinc-500" />
                        <p className="text-xs text-zinc-500">{servers.length === 0 ? "No connections yet" : "No matches"}</p>
                        {servers.length === 0 && (
                            <button onClick={onAddServer} className="mt-3 text-xs font-medium text-brand-400 hover:text-brand-300">
                                + Add your first connection
                            </button>
                        )}
                    </div>
                ) : (
                    GROUPS.map((group) => {
                        const items = filteredServers.filter((s) => group.match(s.type || "linux"));
                        if (items.length === 0) return null;
                        return (
                            <div key={group.key}>
                                <div className="px-2 mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-zinc-400">
                                    <span>{group.label}</span>
                                    <span className="text-zinc-400">{items.length}</span>
                                </div>
                                <div className="space-y-0.5">
                                    {items.map(renderRow)}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-white/5">
                <button
                    onClick={onOpenSettings}
                    className="flex items-center gap-2 w-full rounded-lg p-2 text-xs font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                >
                    <Settings className="w-4 h-4" />
                    <span>Settings</span>
                </button>
            </div>
        </div>
    );
}
