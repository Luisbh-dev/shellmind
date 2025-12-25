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
        ssh_port: '',
        s3_provider: 'aws',
        s3_bucket: '',
        s3_region: 'us-east-1',
        s3_endpoint: '',
        s3_access_key: '',
        s3_secret_key: '',
        privateKey: '',
        passphrase: ''
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
    const [type, setType] = useState<'linux' | 'windows' | 'ftp' | 's3'>('linux');
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
                ssh_port: initialData.ssh_port ? initialData.ssh_port.toString() : '',
                s3_provider: initialData.s3_provider || 'aws',
                s3_bucket: initialData.s3_bucket || '',
                s3_region: initialData.s3_region || 'us-east-1',
                s3_endpoint: initialData.s3_endpoint || '',
                s3_access_key: initialData.s3_access_key || '',
                s3_secret_key: initialData.s3_secret_key || '',
                privateKey: initialData.privateKey || '',
                passphrase: initialData.passphrase || ''
            });
            setType(initialData.type || 'linux');
            if (initialData.privateKey) {
                setAuthMethod('key');
            } else {
                setAuthMethod('password');
            }
        } else {
            // Reset form if adding new
            setFormData({
                name: '', ip: '', username: '', password: '', port: '', ssh_port: '',
                s3_provider: 'aws', s3_bucket: '', s3_region: 'us-east-1', s3_endpoint: '', s3_access_key: '', s3_secret_key: '',
                privateKey: '', passphrase: ''
            });
            setType('linux');
            setAuthMethod('password');
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
                ssh_port: formData.ssh_port ? parseInt(formData.ssh_port) : undefined,
                s3_provider: type === 's3' ? formData.s3_provider : undefined,
                s3_bucket: type === 's3' ? formData.s3_bucket : undefined,
                s3_region: type === 's3' ? formData.s3_region : undefined,
                s3_endpoint: type === 's3' ? formData.s3_endpoint : undefined,
                s3_access_key: type === 's3' ? formData.s3_access_key : undefined,
                s3_secret_key: type === 's3' ? formData.s3_secret_key : undefined,
                privateKey: type !== 's3' && authMethod === 'key' ? formData.privateKey : undefined,
                passphrase: type !== 's3' && authMethod === 'key' ? formData.passphrase : undefined,
                password: type !== 's3' && authMethod === 'password' ? formData.password : undefined
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
                    setFormData({
                        name: '', ip: '', username: '', password: '', port: '', ssh_port: '',
                        s3_provider: 'aws', s3_bucket: '', s3_region: 'us-east-1', s3_endpoint: '', s3_access_key: '', s3_secret_key: '',
                        privateKey: '', passphrase: ''
                    });
                    setAuthMethod('password');
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
                    <div className="grid grid-cols-4 gap-2 mb-4">
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
                        <button
                            type="button"
                            onClick={() => setType('s3')}
                            className={clsx(
                                "flex flex-col items-center justify-center gap-2 p-3 rounded border transition-all",
                                type === 's3'
                                    ? "bg-blue-900/20 border-blue-800 text-blue-400"
                                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                            )}
                        >
                            <span className="text-lg font-bold">S3</span>
                            <span className="text-xs font-medium">Storage</span>
                        </button>
                    </div>

                    {type !== 's3' && (
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



                            {/* Auth Method Toggle */}
                            {(type === 'linux' || type === 'windows') && (
                                <div className="flex gap-4 border-b border-zinc-800 pb-2">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="authMethod"
                                            checked={authMethod === 'password'}
                                            onChange={() => setAuthMethod('password')}
                                            className="accent-blue-600"
                                        />
                                        <span className="text-xs text-zinc-300">Password</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="authMethod"
                                            checked={authMethod === 'key'}
                                            onChange={() => setAuthMethod('key')}
                                            className="accent-blue-600"
                                        />
                                        <span className="text-xs text-zinc-300">Private Key</span>
                                    </label>
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

                                {authMethod === 'password' ? (
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
                                ) : (
                                    <div>
                                        <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Passphrase (Optional)</label>
                                        <input
                                            type="password"
                                            value={formData.passphrase}
                                            onChange={e => setFormData({ ...formData, passphrase: e.target.value })}
                                            className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                            placeholder="Key Passphrase"
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Private Key Textarea */}
                            {authMethod === 'key' && (
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Private Key (PEM/OpenSSH)</label>
                                    <textarea
                                        value={formData.privateKey}
                                        onChange={e => setFormData({ ...formData, privateKey: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none font-mono text-xs"
                                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                                        rows={5}
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    {type === 's3' && (
                        <div className="space-y-3">
                            <div>
                                <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Display Name</label>
                                <input
                                    required
                                    type="text"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    placeholder="My S3 Bucket"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Provider</label>
                                    <select
                                        value={formData.s3_provider}
                                        onChange={e => setFormData({ ...formData, s3_provider: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                    >
                                        <option value="aws">AWS S3</option>
                                        <option value="other">Other (MinIO, R2, etc)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Bucket Name</label>
                                    <input
                                        required
                                        type="text"
                                        value={formData.s3_bucket}
                                        onChange={e => setFormData({ ...formData, s3_bucket: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="my-backups"
                                    />
                                </div>
                            </div>

                            {formData.s3_provider === 'aws' ? (
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Region</label>
                                    <input
                                        type="text"
                                        value={formData.s3_region}
                                        onChange={e => setFormData({ ...formData, s3_region: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="us-east-1"
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Endpoint URL</label>
                                    <input
                                        required
                                        type="text"
                                        value={formData.s3_endpoint}
                                        onChange={e => setFormData({ ...formData, s3_endpoint: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="https://s3.custom-provider.com"
                                    />
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Access Key</label>
                                    <input
                                        required
                                        type="text"
                                        value={formData.s3_access_key}
                                        onChange={e => setFormData({ ...formData, s3_access_key: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="AKIA..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Secret Key</label>
                                    <input
                                        required
                                        type="password"
                                        value={formData.s3_secret_key}
                                        onChange={e => setFormData({ ...formData, s3_secret_key: e.target.value })}
                                        className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-blue-600 focus:outline-none"
                                        placeholder="••••••"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

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
            </div >
        </div >
    );
}
