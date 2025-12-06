"use client";

import { Terminal, Plus, Search, Monitor, Server as ServerIcon, MoreVertical, Edit2, Trash2, Codepen, Disc, Box, AppWindow } from "lucide-react";
import { clsx } from "clsx";

interface SidebarProps {
  servers: any[];
  onSelectServer: (server: any) => void;
  activeServerId?: number;
  onAddServer: () => void;
  onEditServer: (server: any) => void;
  onOpenSettings: () => void;
}

export default function Sidebar({ servers, onSelectServer, activeServerId, onAddServer, onEditServer, onOpenSettings }: SidebarProps) {

  const handleDelete = async (e: React.MouseEvent, id: number) => {
      e.stopPropagation();
      if(!confirm('Delete server?')) return;
      
      try {
        await fetch(`http://localhost:3001/api/servers/${id}`, { method: 'DELETE' });
        window.location.reload();
      } catch (err) {
        console.error(err);
      }
  };

  const renderServerIcon = (server: any) => {
      const os = (server.os_detail || '').toLowerCase();
      
      if (server.type === 'windows' || os.includes('windows')) {
          return <AppWindow className="w-3.5 h-3.5 text-blue-400" />;
      }
      
      if (os.includes('ubuntu')) return <Codepen className="w-3.5 h-3.5 text-orange-500" />;
      if (os.includes('debian')) return <Disc className="w-3.5 h-3.5 text-red-500" />;
      if (os.includes('centos') || os.includes('fedora') || os.includes('red hat')) return <Box className="w-3.5 h-3.5 text-blue-500" />;
      
      return <ServerIcon className="w-3.5 h-3.5 text-zinc-500" />;
  };

  const getOsBadgeColor = (os: string) => {
      const lower = os.toLowerCase();
      if (lower.includes('ubuntu')) return "bg-orange-900/30 text-orange-300 border-orange-800/50";
      if (lower.includes('debian')) return "bg-red-900/30 text-red-300 border-red-800/50";
      if (lower.includes('centos')) return "bg-purple-900/30 text-purple-300 border-purple-800/50";
      if (lower.includes('windows')) return "bg-blue-900/30 text-blue-300 border-blue-800/50";
      return "bg-zinc-800 text-zinc-400 border-zinc-700";
  };

  return (
    <div className="flex flex-col h-full text-zinc-400 select-none">
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-900/30">
        <div className="flex items-center gap-2 text-zinc-200">
           <Terminal className="w-4 h-4" />
           <span className="font-bold text-sm tracking-wide">ShellMind</span>
        </div>
        <button onClick={onAddServer} className="hover:text-white transition-colors">
             <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Search */}
      <div className="p-3">
        <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input 
                type="text" 
                placeholder="Filter..." 
                className="w-full bg-black border border-zinc-800 text-xs text-zinc-300 rounded pl-8 pr-2 py-1.5 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-600"
            />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2">
            <div className="px-2 mb-2 text-[10px] font-bold text-zinc-600 uppercase tracking-wider">Servers</div>
            <div className="space-y-0.5">
            {servers.map((server) => (
                <div
                key={server.id}
                onClick={() => onSelectServer(server)}
                className={clsx(
                    "group flex items-center justify-between px-3 py-2 rounded cursor-pointer border border-transparent",
                    "transition-all duration-150",
                    activeServerId === server.id 
                        ? "bg-zinc-800 border-zinc-700/50 text-zinc-100" 
                        : "hover:bg-zinc-800/50 hover:text-zinc-200"
                )}
                >
                <div className="flex items-center gap-3 min-w-0 w-full">
                    <div className={clsx(
                        "shrink-0",
                        activeServerId === server.id ? "text-zinc-100" : "text-zinc-500"
                    )}>
                        {renderServerIcon(server)}
                    </div>
                    <div className="flex flex-col min-w-0 flex-1 gap-1">
                        <div className="flex items-center gap-2 w-full">
                            <span className="text-xs font-medium truncate text-zinc-200">{server.name}</span>
                            {server.os_detail && (
                                <span className={clsx(
                                    "px-1.5 py-[1px] rounded-md text-[9px] font-bold border shadow-sm shrink-0 uppercase tracking-wide",
                                    getOsBadgeColor(server.os_detail)
                                )}>
                                    {server.os_detail.split(' ')[0]}
                                </span>
                            )}
                        </div>
                        <span className="text-[11px] text-zinc-400 font-mono truncate">{server.ip}</span>
                    </div>
                </div>
                <div className="flex opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                  <button 
                      onClick={(e) => { e.stopPropagation(); onEditServer(server); }}
                      className="p-1.5 text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 rounded"
                  >
                      <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button 
                      onClick={(e) => handleDelete(e, server.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded"
                  >
                      <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className={clsx(
                        "w-2 h-2 rounded-full shrink-0 shadow-sm transition-colors",
                        activeServerId === server.id 
                            ? "bg-emerald-500 shadow-emerald-500/50" 
                            : "bg-zinc-800 group-hover:bg-zinc-700"
                        )}
                />
                </div>
            ))}
            </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-zinc-800">
        <button 
            onClick={onOpenSettings}
            className="flex items-center gap-2 w-full p-2 hover:bg-zinc-800 rounded text-xs font-medium transition-colors text-zinc-500 hover:text-zinc-300"
        >
            <MoreVertical className="w-3.5 h-3.5" />
            <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
