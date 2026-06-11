import { useState, useEffect, useRef } from 'react';
import {
    Folder, File as FileIcon, ArrowUp, Download, Upload, RefreshCw, Trash2, FolderPlus,
    Pencil, ChevronRight, HardDrive, Home, Loader2, FileArchive, FileText, FileCode,
    FileImage, X
} from 'lucide-react';
import { cn } from '@/lib/cn';
import io, { Socket } from 'socket.io-client';
import { Modal, Button, Input, Field, useToast, useConfirm } from '@/components/ui';
import { SOCKET_URL } from '@/config';

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

type UploadJob = { name: string; status: 'pending' | 'uploading' | 'done' | 'error'; progress: number };

const fileIconFor = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return <FileArchive className="w-4 h-4 text-amber-400/80" />;
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return <FileImage className="w-4 h-4 text-fuchsia-400/80" />;
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'go', 'rs', 'c', 'cpp', 'java', 'rb', 'php', 'json', 'yml', 'yaml', 'html', 'css'].includes(ext)) return <FileCode className="w-4 h-4 text-brand-400/80" />;
    if (['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'env'].includes(ext)) return <FileText className="w-4 h-4 text-zinc-400" />;
    return <FileIcon className="w-4 h-4 text-zinc-400" />;
};

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
    const [editingPath, setEditingPath] = useState(false);
    const [pathDraft, setPathDraft] = useState(currentPath);
    const [isDragging, setIsDragging] = useState(false);
    const [uploads, setUploads] = useState<UploadJob[]>([]);
    const operationTimeoutRef = useRef<number | null>(null);
    const dragCounter = useRef(0);
    const isUploadingRef = useRef(false);

    const toast = useToast();
    const confirm = useConfirm();
    const currentPathRef = useRef(currentPath);

    const keyOf = (item: FileItem) => `${item.isDir ? 'dir' : 'file'}:${item.name}`;

    const normalizeFiles = (items: FileItem[]) => {
        const seen = new Set<string>();
        const unique = items.filter((item) => {
            const key = keyOf(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        // Folders first, then alphabetical.
        return unique.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
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

    useEffect(() => {
        currentPathRef.current = currentPath;
        setPathDraft(currentPath);
    }, [currentPath]);

    useEffect(() => {
        setFiles([]);
        closeCreateFolderModal();
        closeRenameModal();
        clearOperationTimeout();
        const defaultPath = (server.type === 'windows' || server.type === 'ftp' || server.type === 's3') ? '/' : '/root';
        setCurrentPath(defaultPath);
    }, [server.id, server.type]);

    const formatSize = (bytes: number) => {
        if (!bytes) return '—';
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
        const newSocket = io(SOCKET_URL);
        setSocket(newSocket);

        newSocket.on('connect', () => {
            const portToUse = server.type === 'windows'
                ? (server.ssh_port || 22)
                : (server.port || 22);

            // Credentials (password / S3 secret) are resolved server-side
            // from serverId; they never travel through the browser.
            newSocket.emit('start-ssh', {
                host: server.ip,
                username: server.username,
                type: server.type,
                port: portToUse,
                s3_provider: server.s3_provider,
                s3_bucket: server.s3_bucket,
                s3_region: server.s3_region,
                s3_endpoint: server.s3_endpoint,
                s3_access_key: server.s3_access_key,
                serverId: server.id
            });
        });

        newSocket.on('ssh-output', () => { });

        newSocket.on('connection-ready', () => {
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
            clearOperationTimeout();
            setIsLoading(false);
            toast.error('Transfer error', err);
        });

        // Note: file writes are handled per-file inside uploadFiles() with a
        // scoped socket.once(), which also drives the post-upload refresh. We do
        // NOT register a global 'sftp-write-success' handler here — doing so
        // would double-fire on every upload and collide with other operations.

        newSocket.on('sftp-mkdir-success', (createdPath: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            closeCreateFolderModal();
            toast.success('Folder created', extractNameFromPath(createdPath || ''));
            window.setTimeout(() => newSocket.emit('sftp-list', currentPathRef.current), 150);
        });

        newSocket.on('sftp-mkdir-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            toast.error('Could not create folder', err);
        });

        newSocket.on('sftp-rename-success', () => {
            clearOperationTimeout();
            setIsLoading(false);
            closeRenameModal();
            toast.success('Renamed');
            window.setTimeout(() => newSocket.emit('sftp-list', currentPathRef.current), 150);
        });

        newSocket.on('sftp-rename-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            toast.error('Could not rename', err);
        });

        newSocket.on('sftp-delete-success', () => {
            clearOperationTimeout();
            setIsLoading(false);
            newSocket.emit('sftp-list', currentPathRef.current);
        });

        newSocket.on('sftp-delete-error', (err: string) => {
            clearOperationTimeout();
            setIsLoading(false);
            toast.error('Could not delete', err);
        });

        return () => {
            clearOperationTimeout();
            newSocket.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const joinPath = (name: string) => (currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`);

    const handleDownload = (file: FileItem) => {
        if (!socket) return;
        const requested = joinPath(file.name);
        toast.info('Downloading', file.name);

        const cleanup = () => {
            window.clearTimeout(timer);
            socket.off('sftp-file-content', onContent);
            socket.off('sftp-error', onError);
        };
        const onContent = ({ path, data }: { path: string; data: string }) => {
            // Ignore responses that belong to a different concurrent download.
            if (path && path !== requested && extractNameFromPath(path) !== file.name) return;
            cleanup();
            const link = document.createElement('a');
            link.href = `data:application/octet-stream;base64,${data}`;
            link.download = file.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
        const onError = () => cleanup();
        const timer = window.setTimeout(() => {
            cleanup();
            toast.error('Download timed out', file.name);
        }, 60000);

        socket.on('sftp-file-content', onContent);
        socket.once('sftp-error', onError);
        socket.emit('sftp-read', requested);
    };

    // ---- Upload (chunked, with progress) -----------------------------------
    const CHUNK_SIZE = 256 * 1024; // raw bytes per chunk (well under the socket limit)

    // Streams one file in acked chunks so large files don't exceed the socket
    // message limit, and reports progress as a percentage.
    const uploadFileChunked = (file: File, onProgress: (pct: number) => void) =>
        new Promise<void>((resolve, reject) => {
            const sock = socket;
            if (!sock) return reject(new Error('Not connected'));

            let offset = 0;
            let settled = false;
            let timer: number | undefined;

            const cleanup = () => {
                if (timer) window.clearTimeout(timer);
                sock.off('sftp-upload-ready', onReady);
                sock.off('sftp-upload-ack', onAck);
                sock.off('sftp-upload-error', onError);
                sock.off('sftp-write-success', onDone);
            };
            const finish = (err?: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (err) { try { sock.emit('sftp-upload-cancel'); } catch { /* ignore */ } reject(err); }
                else resolve();
            };
            const armTimer = () => {
                if (timer) window.clearTimeout(timer);
                timer = window.setTimeout(() => finish(new Error('Upload timed out')), 60000);
            };

            const sendNextChunk = () => {
                if (settled) return;
                if (offset >= file.size) { sock.emit('sftp-upload-end'); armTimer(); return; }
                const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
                const reader = new FileReader();
                reader.onerror = () => finish(new Error('Could not read file'));
                reader.onload = () => {
                    if (settled) return;
                    const b64 = ((reader.result as string).split(',')[1]) || '';
                    sock.emit('sftp-upload-chunk', b64);
                    armTimer();
                };
                reader.readAsDataURL(slice);
            };

            function onReady() { armTimer(); sendNextChunk(); }
            function onAck() {
                offset = Math.min(offset + CHUNK_SIZE, file.size);
                onProgress(file.size ? Math.round((offset / file.size) * 100) : 100);
                sendNextChunk();
            }
            function onError(msg: string) { finish(new Error(msg || 'Upload error')); }
            function onDone() { finish(); }

            sock.on('sftp-upload-ready', onReady);
            sock.on('sftp-upload-ack', onAck);
            sock.on('sftp-upload-error', onError);
            sock.on('sftp-write-success', onDone);
            sock.emit('sftp-upload-start', { path: joinPath(file.name) });
            armTimer();
        });

    const uploadFiles = async (fileList: File[]) => {
        if (!socket || fileList.length === 0) return;
        if (isUploadingRef.current) {
            toast.info('Upload in progress', 'Wait for the current upload to finish.');
            return;
        }
        isUploadingRef.current = true;
        setUploads(fileList.map((f) => ({ name: f.name, status: 'pending', progress: 0 })));

        let failed = 0;
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            setUploads((prev) => prev.map((u, idx) => idx === i ? { ...u, status: 'uploading', progress: 0 } : u));
            try {
                // eslint-disable-next-line no-await-in-loop
                await uploadFileChunked(file, (pct) => {
                    setUploads((prev) => prev.map((u, idx) => idx === i ? { ...u, progress: pct } : u));
                });
                setUploads((prev) => prev.map((u, idx) => idx === i ? { ...u, status: 'done', progress: 100 } : u));
            } catch (err: any) {
                failed += 1;
                setUploads((prev) => prev.map((u, idx) => idx === i ? { ...u, status: 'error' } : u));
                toast.error(`Upload failed: ${file.name}`, err?.message);
            }
        }

        isUploadingRef.current = false;
        if (!failed) toast.success(`Uploaded ${fileList.length} file${fileList.length > 1 ? 's' : ''}`);
        socket.emit('sftp-list', currentPathRef.current);
        window.setTimeout(() => setUploads([]), 2000);
    };

    const handleUploadInput = (event: React.ChangeEvent<HTMLInputElement>) => {
        const list = Array.from(event.target.files || []);
        event.target.value = '';
        void uploadFiles(list);
    };

    // ---- Drag & drop -------------------------------------------------------
    const onDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) {
            dragCounter.current += 1;
            setIsDragging(true);
        }
    };
    const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
    const onDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) { setIsDragging(false); dragCounter.current = 0; }
    };
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounter.current = 0;
        setIsDragging(false);
        const dropped = Array.from(e.dataTransfer.files || []);
        if (dropped.length) void uploadFiles(dropped);
    };

    // ---- Delete (single + bulk via confirm) --------------------------------
    const deleteOne = (file: FileItem) => new Promise<boolean>((resolve) => {
        if (!socket) return resolve(false);
        const onSuccess = () => { cleanup(); resolve(true); };
        // The backend reports delete failures via the generic 'sftp-error' event.
        const onError = () => { cleanup(); resolve(false); };
        const timer = window.setTimeout(() => { cleanup(); resolve(false); }, 12000);
        const cleanup = () => {
            window.clearTimeout(timer);
            socket.off('sftp-delete-success', onSuccess);
            socket.off('sftp-error', onError);
        };
        socket.once('sftp-delete-success', onSuccess);
        socket.once('sftp-error', onError);
        socket.emit('sftp-delete', { path: joinPath(file.name), isDir: file.isDir });
    });

    const handleDelete = async (file: FileItem) => {
        const ok = await confirm({
            title: `Delete ${file.isDir ? 'folder' : 'file'}`,
            message: <>This will permanently delete <span className="text-zinc-200 font-medium">{file.name}</span>. This action cannot be undone.</>,
            confirmLabel: 'Delete',
            tone: 'danger'
        });
        if (!ok) return;
        setIsLoading(true);
        const deleted = await deleteOne(file);
        if (deleted) toast.success('Deleted', file.name);
        socket?.emit('sftp-list', currentPathRef.current);
    };

    const submitCreateFolder = () => {
        if (!socket) return;
        const trimmedName = createFolderName.trim();
        if (!trimmedName) return;
        if (/[\\/]/.test(trimmedName)) { toast.error('Invalid name', 'Folder names cannot contain slashes.'); return; }

        setIsLoading(true);
        clearOperationTimeout();
        operationTimeoutRef.current = window.setTimeout(() => {
            setIsLoading(false);
            toast.error('Timed out', 'Creating the folder took too long.');
        }, 8000);

        socket.emit('sftp-mkdir', { parentPath: currentPathRef.current, name: trimmedName });
    };

    const openRenameModal = (file: FileItem) => {
        closeCreateFolderModal();
        setRenameTarget(file);
        setRenameValue(file.name);
    };

    const submitRename = () => {
        if (!socket || !renameTarget) return;
        const trimmedName = renameValue.trim();
        if (!trimmedName) return;
        if (/[\\/]/.test(trimmedName)) { toast.error('Invalid name', 'Names cannot contain slashes.'); return; }
        if (trimmedName === renameTarget.name) { closeRenameModal(); return; }

        setIsLoading(true);
        clearOperationTimeout();
        operationTimeoutRef.current = window.setTimeout(() => {
            setIsLoading(false);
            toast.error('Timed out', 'Renaming took too long.');
        }, 8000);

        socket.emit('sftp-rename', {
            parentPath: currentPathRef.current,
            oldName: renameTarget.name,
            newName: trimmedName,
            isDir: renameTarget.isDir
        });
    };

    // ---- Breadcrumbs -------------------------------------------------------
    const segments = currentPath.split('/').filter(Boolean);
    const rootLabel = server.type === 's3' ? server.s3_bucket || 's3' : server.type === 'ftp' ? 'ftp' : '/';
    const buildPath = (index: number) => '/' + segments.slice(0, index + 1).join('/');

    const protocol = server.type === 's3' ? 's3' : server.type === 'ftp' ? 'ftp' : 'sftp';

    return (
        <div
            className="relative h-full flex flex-col bg-[#0a0b0e] text-zinc-300"
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {/* Header / breadcrumbs */}
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/5 bg-ink-850/60 px-3">
                <button onClick={handleUp} className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 transition" title="Go up">
                    <ArrowUp className="w-4 h-4" />
                </button>

                <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-white/5 bg-ink-900/60 px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5 text-zinc-400 shrink-0">
                        <HardDrive className="w-4 h-4" />
                        <span className="text-xs font-mono hidden sm:inline">{protocol}://{server.ip || server.name}</span>
                    </span>
                    {editingPath ? (
                        <input
                            autoFocus
                            value={pathDraft}
                            onChange={(e) => setPathDraft(e.target.value)}
                            onBlur={() => setEditingPath(false)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { handleNavigate(pathDraft); setEditingPath(false); }
                                if (e.key === 'Escape') { setPathDraft(currentPath); setEditingPath(false); }
                            }}
                            className="ml-1 flex-1 bg-transparent text-xs text-zinc-100 font-mono outline-none"
                        />
                    ) : (
                        <div
                            className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hide cursor-text"
                            onDoubleClick={() => { setPathDraft(currentPath); setEditingPath(true); }}
                            title="Double-click to edit path"
                        >
                            <button
                                onClick={() => handleNavigate('/')}
                                className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-100 shrink-0"
                            >
                                <Home className="w-3.5 h-3.5" />
                            </button>
                            {segments.map((seg, i) => (
                                <span key={i} className="flex items-center shrink-0">
                                    <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                                    <button
                                        onClick={() => handleNavigate(buildPath(i))}
                                        className={cn(
                                            "rounded px-1 py-0.5 text-xs hover:bg-white/5 hover:text-zinc-100 whitespace-nowrap",
                                            i === segments.length - 1 ? "text-zinc-100 font-medium" : "text-zinc-400"
                                        )}
                                    >
                                        {seg}
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                <label className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 transition cursor-pointer" title="Upload files">
                    <Upload className="w-4 h-4" />
                    <input type="file" multiple className="hidden" onChange={handleUploadInput} />
                </label>
                <button
                    onClick={() => { closeRenameModal(); setCreateFolderName(''); setCreateFolderOpen(true); }}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 transition disabled:opacity-40"
                    title="New folder"
                    disabled={!socket}
                >
                    <FolderPlus className="w-4 h-4" />
                </button>
                <button
                    onClick={() => handleNavigate(currentPath)}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 transition"
                    title="Refresh"
                >
                    <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
                </button>
            </div>

            {/* File list */}
            <div className="flex-1 overflow-auto scrollbar-thin">
                <table className="w-full text-left text-[13px]">
                    <thead className="bg-ink-850/80 text-zinc-400 border-b border-white/5 sticky top-0 z-10 backdrop-blur">
                        <tr>
                            <th className="px-3 py-2 w-9"></th>
                            <th className="px-3 py-2 font-medium">Name</th>
                            <th className="px-3 py-2 w-24 text-right font-medium">Size</th>
                            <th className="px-3 py-2 w-28 text-right font-medium hidden md:table-cell">Modified</th>
                            <th className="px-3 py-2 w-16 text-right font-medium hidden lg:table-cell">Perms</th>
                            <th className="px-3 py-2 w-20 text-center font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading && files.length === 0 ? (
                            Array.from({ length: 8 }).map((_, i) => (
                                <tr key={i} className="border-b border-white/[0.03]">
                                    <td className="px-3 py-2.5"><div className="h-4 w-4 rounded bg-white/5 shimmer" /></td>
                                    <td className="px-3 py-2.5"><div className="h-3.5 w-40 rounded bg-white/5 shimmer" /></td>
                                    <td className="px-3 py-2.5"><div className="h-3.5 w-12 rounded bg-white/5 shimmer ml-auto" /></td>
                                    <td className="px-3 py-2.5 hidden md:table-cell"><div className="h-3.5 w-16 rounded bg-white/5 shimmer ml-auto" /></td>
                                    <td className="px-3 py-2.5 hidden lg:table-cell"></td>
                                    <td className="px-3 py-2.5"></td>
                                </tr>
                            ))
                        ) : files.length === 0 ? (
                            <tr>
                                <td colSpan={6}>
                                    <div className="flex flex-col items-center justify-center gap-3 py-20 text-zinc-500">
                                        <Folder className="w-12 h-12 opacity-20" />
                                        <p className="text-sm">This folder is empty</p>
                                        <p className="text-xs text-zinc-400">Drag &amp; drop files here to upload</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            files.map((file) => {
                                return (
                                    <tr
                                        key={keyOf(file)}
                                        className="group cursor-pointer border-b border-white/[0.03] transition-colors hover:bg-white/[0.03]"
                                        onDoubleClick={() => file.isDir ? handleNavigate(joinPath(file.name)) : handleDownload(file)}
                                    >
                                        <td className="px-3 py-2.5 text-center">
                                            {file.isDir ? <Folder className="w-4 h-4 text-brand-400 fill-brand-500/20 inline" /> : <span className="inline-flex">{fileIconFor(file.name)}</span>}
                                        </td>
                                        <td className="px-3 py-2.5 font-medium text-zinc-200 group-hover:text-white truncate max-w-0">
                                            {file.name}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-zinc-400 font-mono">
                                            {!file.isDir && formatSize(file.size)}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-zinc-400 hidden md:table-cell">
                                            {file.mtime ? new Date(file.mtime * 1000).toLocaleDateString() : '—'}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-zinc-500 font-mono hidden lg:table-cell">
                                            {file.permissions ? file.permissions.toString(8).slice(-3) : '—'}
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <div className="flex items-center justify-end gap-1">
                                                {!file.isDir && (
                                                    <button onClick={(e) => { e.stopPropagation(); handleDownload(file); }} className="rounded-md border border-white/5 bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/10 hover:text-brand-300 hover:border-brand-500/30 transition-colors" title="Download">
                                                        <Download className="w-4 h-4" />
                                                    </button>
                                                )}
                                                <button onClick={(e) => { e.stopPropagation(); openRenameModal(file); }} className="rounded-md border border-white/5 bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/10 hover:text-brand-300 hover:border-brand-500/30 transition-colors" title="Rename">
                                                    <Pencil className="w-4 h-4" />
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); void handleDelete(file); }} className="rounded-md border border-white/5 bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-rose-500/15 hover:text-rose-400 hover:border-rose-500/30 transition-colors" title="Delete">
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Upload progress dock */}
            {uploads.length > 0 && (
                <div className="absolute bottom-4 right-4 z-30 w-64 overflow-hidden rounded-xl border border-white/10 bg-ink-700/95 shadow-panel backdrop-blur animate-slide-up">
                    <div className="flex items-center justify-between border-b border-white/5 px-3 py-2 text-xs text-zinc-400">
                        <span>Uploading {uploads.filter(u => u.status === 'done').length}/{uploads.length}</span>
                    </div>
                    <div className="max-h-44 overflow-y-auto scrollbar-thin p-2 space-y-2">
                        {uploads.map((u, i) => (
                            <div key={i} className="space-y-1">
                                <div className="flex items-center gap-2 text-xs">
                                    {u.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-400 shrink-0" />}
                                    {u.status === 'done' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                                    {u.status === 'error' && <X className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
                                    {u.status === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />}
                                    <span className="truncate text-zinc-300 flex-1">{u.name}</span>
                                    {u.status === 'uploading' && <span className="shrink-0 text-[10px] text-zinc-400 font-mono">{u.progress}%</span>}
                                    {u.status === 'error' && <span className="shrink-0 text-[10px] text-rose-400">failed</span>}
                                </div>
                                {(u.status === 'uploading' || u.status === 'pending') && (
                                    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
                                            style={{ width: `${u.status === 'uploading' ? u.progress : 0}%` }}
                                        />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Drag overlay */}
            {isDragging && (
                <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-brand-500/10 backdrop-blur-sm animate-fade-in">
                    <div className="rounded-2xl border-2 border-dashed border-brand-400/60 bg-ink-800/80 px-10 py-8 text-center">
                        <Upload className="mx-auto mb-2 h-8 w-8 text-brand-400" />
                        <div className="text-sm font-semibold text-zinc-100">Drop to upload</div>
                        <div className="text-xs text-zinc-400 mt-0.5">to {currentPath}</div>
                    </div>
                </div>
            )}

            {/* Create folder modal */}
            <Modal
                open={createFolderOpen}
                onClose={closeCreateFolderModal}
                title="Create folder"
                description={`Inside ${currentPath}`}
                icon={<FolderPlus className="w-4 h-4" />}
                footer={
                    <>
                        <Button variant="ghost" size="sm" onClick={closeCreateFolderModal}>Cancel</Button>
                        <Button variant="primary" size="sm" disabled={!createFolderName.trim()} onClick={submitCreateFolder}>Create</Button>
                    </>
                }
            >
                <Field label="Folder name">
                    <Input
                        autoFocus
                        value={createFolderName}
                        onChange={(e) => setCreateFolderName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitCreateFolder(); }}
                        placeholder="new-folder"
                    />
                </Field>
            </Modal>

            {/* Rename modal */}
            <Modal
                open={!!renameTarget}
                onClose={closeRenameModal}
                title={`Rename ${renameTarget?.isDir ? 'folder' : 'file'}`}
                description={renameTarget ? `Current: ${renameTarget.name}` : undefined}
                icon={<Pencil className="w-4 h-4" />}
                footer={
                    <>
                        <Button variant="ghost" size="sm" onClick={closeRenameModal}>Cancel</Button>
                        <Button variant="primary" size="sm" disabled={!renameValue.trim()} onClick={submitRename}>Rename</Button>
                    </>
                }
            >
                <Field label="New name">
                    <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); }}
                        placeholder="New name"
                    />
                </Field>
            </Modal>
        </div>
    );
}
