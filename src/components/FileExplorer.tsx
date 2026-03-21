import { useState, useEffect, useRef } from 'react';
import { Folder, File, ArrowUp, Download, Upload, RefreshCw, Trash2, FolderPlus, Pencil } from 'lucide-react';
import { clsx } from 'clsx';
import io, { Socket } from 'socket.io-client';

interface FileItem {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
    permissions: number;
}

interface FileExplorerProps {
    server: any;
    isVisible: boolean;
}

export default function FileExplorer({ server, isVisible }: FileExplorerProps) {
    const [files, setFiles] = useState<FileItem[]>([]);
    const [currentPath, setCurrentPath] = useState((server.type === 'windows' || server.type === 'ftp' || server.type === 's3') ? '/' : '/root');
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isConnectionReady, setIsConnectionReady] = useState(false);
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [createFolderName, setCreateFolderName] = useState('');
    const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
    const operationTimeoutRef = useRef<number | null>(null);

    const currentPathRef = useRef(currentPath);

    const normalizeFiles = (items: FileItem[]) => {
        const seen = new Set<string>();
        return items.filter((item) => {
            const key = `${item.isDir ? 'dir' : 'file'}:${item.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };

    const extractNameFromPath = (path: string) => {
        const parts = path.split('/').filter(Boolean);
        return parts[parts.length - 1] || path.replace(/\/+$/, '');
    };

    const clearOperationTimeout = () => {
        if (operationTimeoutRef.current) {
            window.clearTimeout(operationTimeoutRef.current);
            operationTimeoutRef.current = null;
        }
    };

    const closeCreateFolderModal = () => {
        setCreateFolderOpen(false);
        setCreateFolderName('');
    };

    const closeRenameModal = () => {
        setRenameTarget(null);
        setRenameValue('');
    };

    const closeDeleteModal = () => {
        setDeleteTarget(null);
    };

    useEffect(() => {
        currentPathRef.current = currentPath;
    }, [currentPath]);

    useEffect(() => {
        setFiles([]);
        closeCreateFolderModal();
        closeRenameModal();
        closeDeleteModal();
        clearOperationTimeout();
        // Default to /root for Linux SSH, but / for Windows and FTP
        const defaultPath = (server.type === 'windows' || server.type === 'ftp' || server.type === 's3') ? '/' : '/root';
        setCurrentPath(defaultPath);
    }, [server.id, server.type]);



    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    useEffect(() => {
        if (!isVisible) {
            setIsConnectionReady(false);
            setIsLoading(false);
            clearOperationTimeout();
            return;
        }

        setIsConnectionReady(false);
        const newSocket = io('http://localhost:3001');
        setSocket(newSocket);

        newSocket.on('connect', () => {
            const portToUse = server.type === 'windows'
                ? (server.ssh_port || 22)
                : (server.port || 22);

            newSocket.emit('start-ssh', {
                host: server.ip,
                username: server.username,
                password: server.password,
                type: server.type,
                port: portToUse,
                s3_provider: server.s3_provider,
                s3_bucket: server.s3_bucket,
                s3_region: server.s3_region,
                s3_endpoint: server.s3_endpoint,
                s3_access_key: server.s3_access_key,
                s3_secret_key: server.s3_secret_key
            });
        });

        newSocket.on('ssh-output', () => { });

        newSocket.on('connection-ready', () => {
            console.log("Connection ready received");
            setIsConnectionReady(true);
            newSocket.emit('sftp-list', currentPathRef.current);
            setIsLoading(true);
        });

        newSocket.on('sftp-files', ({ path, files }: { path: string, files: FileItem[] }) => {
            setFiles(normalizeFiles(files));
            setCurrentPath(path);
            setIsLoading(false);
        });

        newSocket.on('sftp-error', (err: string) => {
            console.error('SFTP Error:', err);
            clearOperationTimeout();
            setIsLoading(false);
            alert('SFTP Error: ' + err);
        });

        newSocket.on('sftp-write-success', (path: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            newSocket.emit('sftp-list', currentPathRef.current);
        });

        newSocket.on('sftp-mkdir-success', (createdPath: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            closeCreateFolderModal();
            const createdName = extractNameFromPath(createdPath || '');
            if (createdName) {
                setFiles((prev) => normalizeFiles([
                    {
                        name: createdName,
                        isDir: true,
                        size: 0,
                        mtime: Math.floor(Date.now() / 1000),
                        permissions: 0
                    },
                    ...prev
                ]));
            }
            window.setTimeout(() => {
                newSocket.emit('sftp-list', currentPathRef.current);
            }, 150);
        });

        newSocket.on('sftp-mkdir-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            alert('SFTP Error: ' + err);
        });

        newSocket.on('sftp-rename-success', ({ oldName, newName, isDir }: { oldName: string, newName: string, isDir: boolean }) => {
            clearOperationTimeout();
            setIsLoading(false);
            closeRenameModal();
            if (oldName && newName) {
                setFiles((prev) => normalizeFiles(prev.map((item) => {
                    if (item.name === oldName && item.isDir === isDir) {
                        return { ...item, name: newName };
                    }
                    return item;
                })));
            }
            window.setTimeout(() => {
                newSocket.emit('sftp-list', currentPathRef.current);
            }, 150);
        });

        newSocket.on('sftp-rename-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            alert('SFTP Error: ' + err);
        });

        newSocket.on('sftp-delete-success', (path: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            closeDeleteModal();
            newSocket.emit('sftp-list', currentPathRef.current);
        });

        newSocket.on('sftp-delete-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            alert('SFTP Error: ' + err);
        });

        return () => {
            clearOperationTimeout();
            newSocket.disconnect();
        };
    }, [server, isVisible]);


    useEffect(() => {
        if (isVisible && socket && isConnectionReady) {
            socket.emit('sftp-list', currentPathRef.current);
            setIsLoading(true);
        }
    }, [isVisible, socket, isConnectionReady]);

    const handleNavigate = (path: string) => {
        if (!socket) return;
        setIsLoading(true);
        socket.emit('sftp-list', path);
        setCurrentPath(path);
    };

    const handleUp = () => {
        const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
        handleNavigate(parent);
    };

    const handleDownload = (file: FileItem) => {
        if (!socket) return;
        socket.emit('sftp-read', currentPath + '/' + file.name);

        socket.once('sftp-file-content', ({ path, data }) => {
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
            const separator = currentPath.endsWith('/') ? '' : '/';
            const fullPath = `${currentPath}${separator}${file.name}`;

            socket.emit('sftp-write', {
                path: fullPath,
                data: base64
            });
        };
        reader.readAsDataURL(file);
        event.target.value = '';
    };

    const handleDelete = (file: FileItem) => {
        if (!socket) return;
        closeCreateFolderModal();
        closeRenameModal();
        setDeleteTarget(file);
    };

    const submitDelete = () => {
        if (!socket || !deleteTarget) return;

        setIsLoading(true);
        clearOperationTimeout();
        operationTimeoutRef.current = window.setTimeout(() => {
            setIsLoading(false);
            alert('Deleting took too long. Please try again.');
        }, 8000);

        const separator = currentPath.endsWith('/') ? '' : '/';
        const fullPath = `${currentPath}${separator}${deleteTarget.name}`;

        socket.emit('sftp-delete', {
            path: fullPath,
            isDir: deleteTarget.isDir
        });
    };

    const openCreateFolderModal = () => {
        closeRenameModal();
        closeDeleteModal();
        setCreateFolderName('');
        setCreateFolderOpen(true);
    };

    const submitCreateFolder = () => {
        if (!socket) return;

        const trimmedName = createFolderName.trim();
        if (!trimmedName) return;
        if (/[\\/]/.test(trimmedName)) {
            alert('Folder names cannot contain slashes.');
            return;
        }

        setIsLoading(true);
        clearOperationTimeout();
        operationTimeoutRef.current = window.setTimeout(() => {
            setIsLoading(false);
            alert('Creating the folder took too long. Please try again.');
        }, 8000);

        socket.emit('sftp-mkdir', {
            parentPath: currentPathRef.current,
            name: trimmedName
        });
    };

    const openRenameModal = (file: FileItem) => {
        closeCreateFolderModal();
        closeDeleteModal();
        setRenameTarget(file);
        setRenameValue(file.name);
    };

    const submitRename = () => {
        if (!socket || !renameTarget) return;

        const trimmedName = renameValue.trim();
        if (!trimmedName) return;
        if (/[\\/]/.test(trimmedName)) {
            alert('Names cannot contain slashes.');
            return;
        }

        if (trimmedName === renameTarget.name) {
            closeRenameModal();
            return;
        }

        setIsLoading(true);
        clearOperationTimeout();
        operationTimeoutRef.current = window.setTimeout(() => {
            setIsLoading(false);
            alert('Renaming took too long. Please try again.');
        }, 8000);

        socket.emit('sftp-rename', {
            parentPath: currentPathRef.current,
            oldName: renameTarget.name,
            newName: trimmedName,
            isDir: renameTarget.isDir
        });
    };

    return (
        <div className="relative h-full flex flex-col bg-[#0a0a0a] text-zinc-300 font-sans">
            <div className="h-10 border-b border-zinc-800 flex items-center px-4 gap-2 bg-zinc-900/30">
                <button onClick={handleUp} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400" title="Go Up">
                    <ArrowUp className="w-4 h-4" />
                </button>

                <div className="flex-1 flex items-center bg-black border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-400 font-mono">
                    <span className="mr-2 text-zinc-600">
                        {server.type === 's3' ? 's3' : (server.type === 'ftp' ? 'ftp' : 'sftp')}://{server.ip || server.name}
                    </span>
                    <input
                        className="bg-transparent w-full outline-none text-zinc-200"
                        value={currentPath}
                        onChange={(e) => setCurrentPath(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleNavigate(currentPath)}
                    />
                </div>

                <label className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 cursor-pointer" title="Upload File">
                    <Upload className="w-4 h-4" />
                    <input type="file" className="hidden" onChange={handleUpload} />
                </label>

                <button
                    onClick={openCreateFolderModal}
                    className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Create Folder"
                    disabled={!socket || isLoading}
                >
                    <FolderPlus className="w-4 h-4" />
                </button>

                <button
                    onClick={() => handleNavigate(currentPath)}
                    className={clsx("p-1.5 hover:bg-zinc-800 rounded text-zinc-400", isLoading && "animate-spin")}
                    title="Refresh"
                >
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

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
                        {files.map((file, index) => (
                            <tr
                                key={`${file.isDir ? 'dir' : 'file'}:${file.name}:${index}`}
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
                                        onClick={(e) => { e.stopPropagation(); openRenameModal(file); }}
                                        className="p-1 hover:bg-zinc-700 rounded text-zinc-500 hover:text-zinc-300"
                                        title="Rename"
                                    >
                                        <Pencil className="w-3 h-3" />
                                    </button>
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
                    </tbody>
                </table>
            </div>

            {createFolderOpen && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 backdrop-blur-[1px] px-4">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            submitCreateFolder();
                        }}
                        className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/40"
                    >
                        <div className="px-4 py-3 border-b border-zinc-800">
                            <div className="text-sm font-semibold text-zinc-100">Create folder</div>
                            <div className="text-xs text-zinc-500 mt-1">
                                Folder will be created inside {currentPathRef.current}
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            <input
                                autoFocus
                                value={createFolderName}
                                onChange={(e) => setCreateFolderName(e.target.value)}
                                placeholder="Folder name"
                                className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeCreateFolderModal}
                                    className="px-3 py-2 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!createFolderName.trim()}
                                    className="px-3 py-2 rounded-lg bg-blue-600 text-sm text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500"
                                >
                                    Create
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
            )}

            {renameTarget && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 backdrop-blur-[1px] px-4">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            submitRename();
                        }}
                        className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/40"
                    >
                        <div className="px-4 py-3 border-b border-zinc-800">
                            <div className="text-sm font-semibold text-zinc-100">Rename {renameTarget.isDir ? 'folder' : 'file'}</div>
                            <div className="text-xs text-zinc-500 mt-1">
                                Current name: {renameTarget.name}
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                placeholder="New name"
                                className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeRenameModal}
                                    className="px-3 py-2 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!renameValue.trim()}
                                    className="px-3 py-2 rounded-lg bg-blue-600 text-sm text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500"
                                >
                                    Rename
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
            )}

            {deleteTarget && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 backdrop-blur-[1px] px-4">
                    <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/40">
                        <div className="px-4 py-3 border-b border-zinc-800">
                            <div className="text-sm font-semibold text-zinc-100">Delete {deleteTarget.isDir ? 'folder' : 'file'}</div>
                            <div className="text-xs text-zinc-500 mt-1">
                                {deleteTarget.name}
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                                This action cannot be undone.
                            </div>
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeDeleteModal}
                                    className="px-3 py-2 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={submitDelete}
                                    className="px-3 py-2 rounded-lg bg-red-500 text-sm text-white font-medium hover:bg-red-400"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
