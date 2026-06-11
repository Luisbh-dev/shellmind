import { useState, useEffect } from 'react';
import { Server, Monitor, Folder, Database, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Modal, Button, Field, Input, PasswordInput, Textarea, Select, useToast } from '@/components/ui';
import { API_BASE } from '@/config';

interface AddServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: () => void;
    initialData?: any; // If provided, we are in edit mode
}

type ServerType = 'linux' | 'windows' | 'ftp' | 's3' | 'local';

const TYPE_OPTIONS: { value: ServerType; label: string; hint: string; icon: React.ReactNode }[] = [
    { value: 'linux', label: 'SSH / Linux', hint: 'Linux & Unix shells over SSH', icon: <Server className="w-5 h-5" /> },
    { value: 'windows', label: 'RDP / Win', hint: 'Windows via OpenSSH + RDP', icon: <Monitor className="w-5 h-5" /> },
    { value: 'ftp', label: 'FTP', hint: 'FTP file transfer', icon: <Folder className="w-5 h-5" /> },
    { value: 's3', label: 'S3', hint: 'S3-compatible object storage', icon: <Database className="w-5 h-5" /> },
    { value: 'local', label: 'Local CLI', hint: 'Run local CLIs (Azure, AWS, kubectl…) in a real terminal', icon: <TerminalSquare className="w-5 h-5" /> }
];

// Local CLI presets. Each opens your local shell (so every subcommand works) and
// optionally runs a context command on connect so you immediately see your identity.
const CLI_PRESETS: { value: string; label: string; initial: string; note: string }[] = [
    { value: 'shell', label: 'System shell', initial: '', note: 'Full local shell (PowerShell / bash).' },
    { value: 'azure', label: 'Azure CLI', initial: 'az account show --output table', note: 'Scoped "az>" console (only az subcommands). Requires the Azure CLI installed.' },
    { value: 'aws', label: 'AWS CLI', initial: 'aws sts get-caller-identity', note: 'Scoped "aws>" console (only aws subcommands). Requires the AWS CLI installed.' },
    { value: 'gcloud', label: 'Google Cloud', initial: 'gcloud config list', note: 'Scoped "gcloud>" console. Requires the gcloud CLI installed.' },
    { value: 'kubectl', label: 'Kubernetes', initial: 'kubectl config get-contexts', note: 'Scoped "kubectl>" console. Requires kubectl installed.' },
    { value: 'docker', label: 'Docker', initial: 'docker version', note: 'Scoped "docker>" console (only docker subcommands). Requires Docker installed.' },
    { value: 'custom', label: 'Custom command', initial: '', note: 'Full shell launching a specific program (e.g. "wsl -d Ubuntu").' }
];

const EMPTY_FORM = {
    name: '', ip: '', username: '', password: '', port: '', ssh_port: '',
    s3_provider: 'aws', s3_bucket: '', s3_region: 'us-east-1', s3_endpoint: '', s3_access_key: '', s3_secret_key: '',
    privateKey: '', passphrase: '',
    command: '', cwd: '', initial_command: '', cli_preset: 'shell'
};

export default function AddServerModal({ isOpen, onClose, onAdd, initialData }: AddServerModalProps) {
    const [formData, setFormData] = useState(EMPTY_FORM);
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
    const [type, setType] = useState<ServerType>('linux');
    const [isLoading, setIsLoading] = useState(false);
    const toast = useToast();

    useEffect(() => {
        if (initialData) {
            // Saved secrets never reach the frontend; the backend only sends
            // has_* flags. Blank secret fields on submit mean "keep saved".
            setFormData({
                name: initialData.name || '',
                ip: initialData.ip || '',
                username: initialData.username || '',
                password: '',
                port: initialData.port ? initialData.port.toString() : '',
                ssh_port: initialData.ssh_port ? initialData.ssh_port.toString() : '',
                s3_provider: initialData.s3_provider || 'aws',
                s3_bucket: initialData.s3_bucket || '',
                s3_region: initialData.s3_region || 'us-east-1',
                s3_endpoint: initialData.s3_endpoint || '',
                s3_access_key: initialData.s3_access_key || '',
                s3_secret_key: '',
                privateKey: '',
                passphrase: '',
                command: initialData.command || '',
                cwd: initialData.cwd || '',
                initial_command: initialData.initial_command || '',
                cli_preset: initialData.cli_preset || 'shell'
            });
            setType(initialData.type || 'linux');
            setAuthMethod(initialData.has_private_key ? 'key' : 'password');
        } else {
            setFormData(EMPTY_FORM);
            setType('linux');
            setAuthMethod('password');
        }
    }, [initialData, isOpen]);

    const set = (patch: Partial<typeof EMPTY_FORM>) => setFormData((prev) => ({ ...prev, ...patch }));

    const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setIsLoading(true);

        try {
            const url = initialData
                ? `${API_BASE}/api/servers/${initialData.id}`
                : `${API_BASE}/api/servers`;
            const method = initialData ? 'PUT' : 'POST';

            const isRemote = type !== 's3' && type !== 'local';
            const payload = {
                ...formData,
                type,
                // Local connections have no host; store a placeholder so the NOT NULL ip column is satisfied.
                ip: type === 'local' ? 'local' : formData.ip,
                port: isRemote && formData.port ? parseInt(formData.port) : undefined,
                ssh_port: isRemote && formData.ssh_port ? parseInt(formData.ssh_port) : undefined,
                s3_provider: type === 's3' ? formData.s3_provider : undefined,
                s3_bucket: type === 's3' ? formData.s3_bucket : undefined,
                s3_region: type === 's3' ? formData.s3_region : undefined,
                s3_endpoint: type === 's3' ? formData.s3_endpoint : undefined,
                s3_access_key: type === 's3' ? formData.s3_access_key : undefined,
                s3_secret_key: type === 's3' ? formData.s3_secret_key : undefined,
                privateKey: isRemote && authMethod === 'key' ? formData.privateKey : undefined,
                passphrase: isRemote && authMethod === 'key' ? formData.passphrase : undefined,
                password: isRemote && authMethod === 'password' ? formData.password : undefined,
                command: type === 'local' ? formData.command : undefined,
                cwd: type === 'local' ? formData.cwd : undefined,
                initial_command: type === 'local' ? formData.initial_command : undefined,
                cli_preset: type === 'local' ? formData.cli_preset : undefined
            };

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                toast.success(initialData ? 'Connection updated' : 'Connection added', formData.name);
                onAdd();
                onClose();
                if (!initialData) { setFormData(EMPTY_FORM); setAuthMethod('password'); }
            } else {
                toast.error('Could not save connection');
            }
        } catch (error) {
            console.error('Error saving server:', error);
            toast.error('Could not save connection', 'Is the backend running?');
        } finally {
            setIsLoading(false);
        }
    };

    const portPlaceholder = type === 'linux' ? '22' : type === 'ftp' ? '21' : '3389';
    const portLabel = type === 'windows' ? 'RDP Port' : type === 'ftp' ? 'FTP Port' : 'SSH Port';

    return (
        <Modal
            open={isOpen}
            onClose={onClose}
            title={initialData ? 'Edit connection' : 'New connection'}
            description={initialData ? 'Update the connection details' : 'Configure how ShellMind connects to your host'}
            icon={<Server className="w-4 h-4" />}
            widthClass="max-w-lg"
            dismissible={!isLoading}
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onClose} disabled={isLoading}>Cancel</Button>
                    <Button variant="primary" size="sm" type="submit" form="add-server-form" loading={isLoading}>
                        {initialData ? 'Save changes' : 'Add connection'}
                    </Button>
                </>
            }
        >
            <form id="add-server-form" onSubmit={handleSubmit} className="space-y-5 max-h-[68vh] overflow-y-auto scrollbar-thin pr-1">
                {/* Type selector */}
                <div className="space-y-2">
                    <div className="grid grid-cols-5 gap-2">
                        {TYPE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => setType(opt.value)}
                                className={cn(
                                    "flex flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3.5 transition-all",
                                    type === opt.value
                                        ? "bg-brand-500/10 border-brand-500/50 text-brand-300 ring-1 ring-brand-500/30"
                                        : "bg-white/[0.02] border-white/5 text-zinc-400 hover:border-white/15 hover:text-zinc-200 hover:bg-white/[0.04]"
                                )}
                            >
                                {opt.icon}
                                <span className="text-xs font-medium">{opt.label}</span>
                            </button>
                        ))}
                    </div>
                    <p className="px-0.5 text-[11px] text-zinc-500">
                        {TYPE_OPTIONS.find((o) => o.value === type)?.hint}
                    </p>
                </div>

                {type === 'local' ? (
                    <div className="space-y-3.5">
                        <Field label="Display name">
                            <Input required value={formData.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Azure (work)" />
                        </Field>

                        <Field label="CLI preset" hint={CLI_PRESETS.find((p) => p.value === formData.cli_preset)?.note}>
                            <Select
                                value={formData.cli_preset}
                                onChange={(value) => {
                                    const preset = CLI_PRESETS.find((p) => p.value === value);
                                    set({
                                        cli_preset: value,
                                        initial_command: preset && preset.value !== 'custom' ? preset.initial : formData.initial_command
                                    });
                                }}
                                options={CLI_PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.note }))}
                            />
                        </Field>

                        {formData.cli_preset === 'custom' && (
                            <Field label="Command" hint="Program to launch. Leave empty for the system shell.">
                                <Input value={formData.command} onChange={(e) => set({ command: e.target.value })} placeholder="e.g. wsl -d Ubuntu" className="font-mono" />
                            </Field>
                        )}

                        <Field label="Run on connect (optional)" hint="Executed automatically when the session opens.">
                            <Input value={formData.initial_command} onChange={(e) => set({ initial_command: e.target.value })} placeholder="az account show" className="font-mono" />
                        </Field>

                        <Field label="Working directory (optional)">
                            <Input value={formData.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="(defaults to your home directory)" className="font-mono" />
                        </Field>
                    </div>
                ) : type !== 's3' ? (
                    <div className="space-y-3.5">
                        <Field label="Display name">
                            <Input required value={formData.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Production DB" />
                        </Field>

                        <div className="grid grid-cols-3 gap-3">
                            <div className="col-span-2">
                                <Field label="Host / IP">
                                    <Input required value={formData.ip} onChange={(e) => set({ ip: e.target.value })} placeholder="192.168.1.10" />
                                </Field>
                            </div>
                            <Field label={portLabel}>
                                <Input type="number" value={formData.port} onChange={(e) => set({ port: e.target.value })} placeholder={portPlaceholder} />
                            </Field>
                        </div>

                        {type === 'windows' && (
                            <div className="grid grid-cols-3 items-end gap-3">
                                <div className="col-span-2 text-xs italic text-zinc-400">Requires OpenSSH Server on Windows</div>
                                <Field label="OpenSSH Port">
                                    <Input type="number" value={formData.ssh_port} onChange={(e) => set({ ssh_port: e.target.value })} placeholder="22" />
                                </Field>
                            </div>
                        )}

                        {(type === 'linux' || type === 'windows') && (
                            <div className="flex gap-1 rounded-lg border border-white/10 bg-ink-900/50 p-1">
                                {(['password', 'key'] as const).map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        onClick={() => setAuthMethod(m)}
                                        className={cn(
                                            "flex-1 rounded-md py-1.5 text-xs font-medium transition-colors",
                                            authMethod === m ? "bg-brand-500/15 text-brand-300" : "text-zinc-400 hover:text-zinc-300"
                                        )}
                                    >
                                        {m === 'password' ? 'Password' : 'Private Key'}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Username">
                                <Input required value={formData.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" />
                            </Field>
                            {authMethod === 'password' ? (
                                <Field label="Password">
                                    <PasswordInput
                                        value={formData.password}
                                        onChange={(e) => set({ password: e.target.value })}
                                        placeholder={initialData?.has_password ? 'Saved — leave blank to keep' : '••••••'}
                                    />
                                </Field>
                            ) : (
                                <Field label="Passphrase (optional)">
                                    <PasswordInput
                                        value={formData.passphrase}
                                        onChange={(e) => set({ passphrase: e.target.value })}
                                        placeholder={initialData?.has_passphrase ? 'Saved — leave blank to keep' : 'Key passphrase'}
                                    />
                                </Field>
                            )}
                        </div>

                        {authMethod === 'key' && (
                            <Field label="Private key (PEM / OpenSSH)">
                                <Textarea
                                    value={formData.privateKey}
                                    onChange={(e) => set({ privateKey: e.target.value })}
                                    placeholder={initialData?.has_private_key ? 'Saved — leave blank to keep the stored key' : '-----BEGIN OPENSSH PRIVATE KEY-----...'}
                                    rows={5}
                                    className="font-mono text-xs"
                                />
                            </Field>
                        )}
                    </div>
                ) : (
                    <div className="space-y-3.5">
                        <Field label="Display name">
                            <Input required value={formData.name} onChange={(e) => set({ name: e.target.value })} placeholder="My S3 Bucket" />
                        </Field>

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Provider">
                                <Select
                                    value={formData.s3_provider}
                                    onChange={(value) => set({ s3_provider: value })}
                                    options={[
                                        { value: 'aws', label: 'AWS S3' },
                                        { value: 'other', label: 'Other (MinIO, R2…)' }
                                    ]}
                                />
                            </Field>
                            <Field label="Bucket name">
                                <Input required value={formData.s3_bucket} onChange={(e) => set({ s3_bucket: e.target.value })} placeholder="my-backups" />
                            </Field>
                        </div>

                        {formData.s3_provider === 'aws' ? (
                            <Field label="Region">
                                <Input value={formData.s3_region} onChange={(e) => set({ s3_region: e.target.value })} placeholder="us-east-1" />
                            </Field>
                        ) : (
                            <Field label="Endpoint URL">
                                <Input required value={formData.s3_endpoint} onChange={(e) => set({ s3_endpoint: e.target.value })} placeholder="https://s3.custom-provider.com" />
                            </Field>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Access key">
                                <Input required value={formData.s3_access_key} onChange={(e) => set({ s3_access_key: e.target.value })} placeholder="AKIA..." />
                            </Field>
                            <Field label="Secret key">
                                <PasswordInput
                                    value={formData.s3_secret_key}
                                    onChange={(e) => set({ s3_secret_key: e.target.value })}
                                    placeholder={initialData?.has_s3_secret_key ? 'Saved — leave blank to keep' : '••••••'}
                                    required={!initialData?.has_s3_secret_key}
                                />
                            </Field>
                        </div>
                    </div>
                )}
            </form>
        </Modal>
    );
}
