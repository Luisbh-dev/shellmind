import { useState, useEffect } from 'react';
import { X, Server, Monitor, Loader2, Folder } from 'lucide-react';
import { clsx } from 'clsx';

interface AddServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: () => void;
    initialData?: any; // If provided, we are in edit mode
}

export default function AddServerModal({ isOpen, onClose, onAdd, initialData }: AddServerModalProps) {
    const [formData, setFormData] = useState({
        name: '',
        ip: '',
        username: '',
        password: '',
        port: '',
        ssh_port: ''
    });
    const [type, setType] = useState<'linux' | 'windows' | 'ftp'>('linux');
    const [isLoading, setIsLoading] = useState(false);

    // Load initial data when modal opens or initialData changes
    useEffect(() => {
        if (initialData) {
            setFormData({
                name: initialData.name || '',
                ip: initialData.ip || '',
                username: initialData.username || '',
                password: initialData.password || '',
                port: initialData.port ? initialData.port.toString() : '',
                ssh_port: initialData.ssh_port ? initialData.ssh_port.toString() : ''
            });
            setType(initialData.type || 'linux');
        } else {
            // Reset form if adding new
            setFormData({ name: '', ip: '', username: '', password: '', port: '', ssh_port: '' });
            setType('linux');
        }
    }, [initialData, isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);

        try {
            const url = initialData
                ? `http://localhost:3001/api/servers/${initialData.id}`
                : 'http://localhost:3001/api/servers';

            const method = initialData ? 'PUT' : 'POST';

            const payload = {
                ...formData,
                type,
                port: formData.port ? parseInt(formData.port) : undefined,
                ssh_port: formData.ssh_port ? parseInt(formData.ssh_port) : undefined
            };

            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                onAdd(); // Refresh list
                onClose();
                if (!initialData) {
                    setFormData({ name: '', ip: '', username: '', password: '', port: '', ssh_port: '' });
                }
            } else {
                console.error("Failed to save server");
            }
        } catch (error) {
            console.error("Error saving server:", error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="w-[400px] bg-[#121212] border border-zinc-800 shadow-2xl rounded-lg overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
                    <span className="text-sm font-bold text-zinc-200 uppercase tracking-wide">{initialData ? 'Edit Server' : 'Add New Server'}</span>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <form onSubmit={handleSubmit} className="p-4 space-y-4">

                    {/* Type Selector */}
                    <div className="grid grid-cols-3 gap-2 mb-4">
                        <button
                            type="button"
                            onClick={() => setType('linux')}
                            className={clsx(
                                "flex flex-col items-center justify-center gap-2 p-3 rounded border transition-all",
                                type === 'linux'
                                    ? "bg-blue-900/20 border-blue-800 text-blue-400"
                                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                            )}
                        >
                            <Server className="w-5 h-5" />
                            <span className="text-xs font-medium">SSH / Linux</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setType('windows')}
                            className={clsx(
                                "flex flex-col items-center justify-center gap-2 p-3 rounded border transition-all",
                                type === 'windows'
                                    ? "bg-blue-900/20 border-blue-800 text-blue-400"
                                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                            )}
                        >
                            <Monitor className="w-5 h-5" />
                            <span className="text-xs font-medium">RDP / Win</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setType('ftp')}
                            className={clsx(
                                "flex flex-col items-center justify-center gap-2 p-3 rounded border transition-all",
                                type === 'ftp'
                                    ? "bg-blue-900/20 border-blue-800 text-blue-400"
                                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                            )}
                        >
                            <Folder className="w-5 h-5" />
                            <span className="text-xs font-medium">FTP</span>
                        </button>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Display Name</label>
                            <input
                                required
                                type="text"
                                value={formData.name}
                                onChange={e => setFormData({ ...formData, name: e.target.value })}
                                className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                placeholder="e.g. Production DB"
                            />
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                            <div className="col-span-2">
                                <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Host / IP</label>
                                <input
                                    required
                                    type="text"
                                    value={formData.ip}
                                    onChange={e => setFormData({ ...formData, ip: e.target.value })}
                                    className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    placeholder="192.168.1.10"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">{type === 'windows' ? 'RDP Port' : (type === 'ftp' ? 'FTP Port' : 'SSH Port')}</label>
                                <input
                                    type="number"
                                    value={formData.port}
                                    onChange={e => setFormData({ ...formData, port: e.target.value })}
                                    className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    placeholder={type === 'linux' ? "22" : (type === 'ftp' ? "21" : "3389")}
                                />
                            </div>
                        </div>

                        {/* Windows Extra Port */}
                        {type === 'windows' && (
                            <div className="grid grid-cols-3 gap-3">
                                <div className="col-span-2 text-[10px] text-zinc-500 italic flex items-center">
                                    (Requires OpenSSH Server on Windows)
                                </div>
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">OpenSSH Port</label>
                                    <input
                                        type="number"
                                        value={formData.ssh_port}
                                        onChange={e => setFormData({ ...formData, ssh_port: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="22"
                                    />
                                </div>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Username</label>
                                <input
                                    required
                                    type="text"
                                    value={formData.username}
                                    onChange={e => setFormData({ ...formData, username: e.target.value })}
                                    className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    placeholder="root"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Password</label>
                                <input
                                    type="password"
                                    value={formData.password}
                                    onChange={e => setFormData({ ...formData, password: e.target.value })}
                                    className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    placeholder="••••••"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isLoading}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                        >
                            {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                            {initialData ? 'Save Changes' : 'Add Server'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
