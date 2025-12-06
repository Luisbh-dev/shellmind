import { useState, useEffect, useRef } from "react";
import { Folder, File, ArrowUp, Download, Upload, RefreshCw, ChevronRight, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import io, { Socket } from "socket.io-client";

interface FileItem {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
    permissions: number;
}

interface FileExplorerProps {
    server: any;
}

export default function FileExplorer({ server }: FileExplorerProps) {
    const [files, setFiles] = useState<FileItem[]>([]);
    // Default path: Linux -> /root, Windows -> / (or . for home?)
    // Better: Default to / for everyone, or let user navigate.
    // Windows OpenSSH usually treats / as C:/
    const [currentPath, setCurrentPath] = useState(server.type === 'windows' ? "/" : "/root"); 
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    
    // Ref to keep track of currentPath without triggering effect re-runs
    const currentPathRef = useRef(currentPath);

    // Update ref when state changes
    useEffect(() => {
        currentPathRef.current = currentPath;
    }, [currentPath]);

    // Reset state when server changes
    useEffect(() => {
        setFiles([]);
        setCurrentPath(server.type === 'windows' ? "/" : "/root");
    }, [server.id]);

    // Format bytes to human readable
    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    useEffect(() => {
        const newSocket = io('http://localhost:3001', { transports: ['websocket'] });
        setSocket(newSocket);

        newSocket.on("connect", () => {
            // ... (same auth logic)
            // Determine port: for Windows use ssh_port, for Linux use standard port
            const portToUse = server.type === 'windows' 
                ? (server.ssh_port || 22)
                : (server.port || 22);

            newSocket.emit("start-ssh", {
                host: server.ip,
                username: server.username,
                password: server.password,
                type: server.type,
                port: portToUse
            });
        });

        newSocket.on("ssh-output", () => {}); 
        
        newSocket.on("sftp-files", ({ path, files }: { path: string, files: FileItem[] }) => {
            setFiles(files);
            // Only update path if it came from server (confirmation)
            setCurrentPath(path);
            setIsLoading(false);
        });

        newSocket.on("sftp-error", (err: string) => {
            console.error("SFTP Error:", err);
            setIsLoading(false);
            alert("SFTP Error: " + err);
        });

        newSocket.on("sftp-write-success", (path: string) => {
            setIsLoading(false);
            // Refresh the current directory using the REF to avoid stale closure
            newSocket.emit("sftp-list", currentPathRef.current);
        });

        newSocket.on("sftp-delete-success", (path: string) => {
            setIsLoading(false);
            // Refresh using REF
            newSocket.emit("sftp-list", currentPathRef.current);
        });

        // Initial list
        setTimeout(() => {
            newSocket.emit("sftp-list", currentPathRef.current);
            setIsLoading(true);
        }, 2000);

        return () => {
            newSocket.disconnect();
        };
    }, [server]); // Only reconnect if server changes

    const handleNavigate = (path: string) => {
        if (!socket) return;
        setIsLoading(true);
        socket.emit("sftp-list", path);
        // Optimistic update? Better wait for server response in sftp-files
        // But we need to update state for UI input
        setCurrentPath(path);
    };

    const handleUp = () => {
        const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
        handleNavigate(parent);
    };

    const handleDownload = (file: FileItem) => {
        if (!socket) return;
        // Request file content
        socket.emit("sftp-read", currentPath + "/" + file.name);
        
        socket.once("sftp-file-content", ({ path, data }) => {
            // Trigger download in browser
            const link = document.createElement('a');
            link.href = `data:application/octet-stream;base64,${data}`;
            link.download = file.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    };

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !socket) return;

        const reader = new FileReader();
        reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            setIsLoading(true);
            // Construct path
            const separator = currentPath.endsWith('/') ? '' : '/';
            const fullPath = `${currentPath}${separator}${file.name}`;
            
            socket.emit("sftp-write", {
                path: fullPath,
                data: base64
            });
        };
        reader.readAsDataURL(file);
        // Reset input
        event.target.value = '';
    };

    const handleDelete = (file: FileItem) => {
        if (!socket) return;
        if (!window.confirm(`Are you sure you want to delete ${file.name}?`)) return;

        setIsLoading(true);
        const separator = currentPath.endsWith('/') ? '' : '/';
        const fullPath = `${currentPath}${separator}${file.name}`;

        socket.emit("sftp-delete", {
            path: fullPath,
            isDir: file.isDir
        });
    };

    return (
        <div className="h-full flex flex-col bg-[#0a0a0a] text-zinc-300 font-sans">
            {/* Toolbar */}
            <div className="h-10 border-b border-zinc-800 flex items-center px-4 gap-2 bg-zinc-900/30">
                <button onClick={handleUp} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400" title="Go Up">
                    <ArrowUp className="w-4 h-4" />
                </button>
                
                <div className="flex-1 flex items-center bg-black border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-400 font-mono">
                    <span className="mr-2 text-zinc-600">sftp://{server.ip}</span>
                    <input 
                        className="bg-transparent w-full outline-none text-zinc-200"
                        value={currentPath}
                        onChange={(e) => setCurrentPath(e.target.value)} // Just UI update
                        onKeyDown={(e) => e.key === 'Enter' && handleNavigate(currentPath)}
                    />
                </div>

                <label className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 cursor-pointer" title="Upload File">
                    <Upload className="w-4 h-4" />
                    <input type="file" className="hidden" onChange={handleUpload} />
                </label>

                <button 
                    onClick={() => handleNavigate(currentPath)} 
                    className={clsx("p-1.5 hover:bg-zinc-800 rounded text-zinc-400", isLoading && "animate-spin")}
                    title="Refresh"
                >
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            {/* File List */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-900/50 text-zinc-500 font-medium border-b border-zinc-800 sticky top-0">
                        <tr>
                            <th className="px-4 py-2 w-8"></th>
                            <th className="px-4 py-2">Name</th>
                            <th className="px-4 py-2 w-24 text-right">Size</th>
                            <th className="px-4 py-2 w-32 text-right">Modified</th>
                            <th className="px-4 py-2 w-24 text-right">Perms</th>
                            <th className="px-4 py-2 w-16 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/50">
                        {files.map((file) => (
                            <tr 
                                key={file.name} 
                                className="hover:bg-zinc-800/30 cursor-pointer group transition-colors"
                                onDoubleClick={() => file.isDir ? handleNavigate(currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`) : handleDownload(file)}
                            >
                                <td className="px-4 py-2 text-center">
                                    {file.isDir ? <Folder className="w-4 h-4 text-blue-400 fill-current" /> : <File className="w-4 h-4 text-zinc-500" />}
                                </td>
                                <td className="px-4 py-2 font-medium text-zinc-300 group-hover:text-white">
                                    {file.name}
                                </td>
                                <td className="px-4 py-2 text-right text-zinc-500 font-mono">
                                    {!file.isDir && formatSize(file.size)}
                                </td>
                                <td className="px-4 py-2 text-right text-zinc-500">
                                    {new Date(file.mtime * 1000).toLocaleDateString()}
                                </td>
                                <td className="px-4 py-2 text-right text-zinc-600 font-mono">
                                    {file.permissions.toString(8).slice(-3)}
                                </td>
                                <td className="px-4 py-2 text-center flex items-center justify-end gap-1">
                                    {!file.isDir && (
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); handleDownload(file); }}
                                            className="p-1 hover:bg-zinc-700 rounded text-zinc-500 hover:text-zinc-300"
                                            title="Download"
                                        >
                                            <Download className="w-3 h-3" />
                                        </button>
                                    )}
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); handleDelete(file); }}
                                        className="p-1 hover:bg-red-900/30 rounded text-zinc-500 hover:text-red-400"
                                        title="Delete"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {files.length === 0 && !isLoading && (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-zinc-600 italic">
                                    Folder is empty or failed to load.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
