import { useState, useEffect } from 'react';
import { Key, Loader2, CheckCircle, Lock, Trash2, ExternalLink } from 'lucide-react';
import { Modal, PasswordInput, Button, useToast, useConfirm } from '@/components/ui';
import { API_BASE } from '@/config';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ProviderKey = 'gemini' | 'minimax';
type ProviderStatus = { configured: boolean; source: 'env' | 'db' | 'none' };
type SettingsStatus = {
  providers: Record<ProviderKey, ProviderStatus>;
  features?: {
    minimaxProxy?: {
      enabled: boolean;
      baseUrl: string;
      allowClientKey: boolean;
      usesProxyAuth: boolean;
      localKeyConfigured: boolean;
      localKeySource: 'env' | 'db' | 'none';
    };
  };
};

const PROVIDER_COPY: Record<ProviderKey, { label: string; placeholder: string; helpUrl: string; helpText: string }> = {
  gemini: {
    label: 'Gemini',
    placeholder: 'AIzaSy...',
    helpUrl: 'https://aistudio.google.com/app/apikey',
    helpText: 'Get your key from Google AI Studio.'
  },
  minimax: {
    label: 'MiniMax',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.minimax.io/',
    helpText: 'Optional BYOK.'
  }
};

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKeys, setApiKeys] = useState<Record<ProviderKey, string>>({ gemini: '', minimax: '' });
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ProviderKey | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderKey | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    if (isOpen) fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const fetchStatus = async () => {
    setIsLoading(true);
    setConnError(null);
    try {
      const res = await fetch(`${API_BASE}/api/config/status`);
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error(e);
      setConnError('Backend server disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent, provider: ProviderKey) => {
    e.preventDefault();
    setSavingProvider(provider);
    try {
      const res = await fetch(`${API_BASE}/api/config/apikey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: apiKeys[provider] })
      });
      if (res.ok) {
        await fetchStatus();
        setApiKeys(prev => ({ ...prev, [provider]: '' }));
        toast.success(`${PROVIDER_COPY[provider].label} key saved`);
      } else {
        const err = await res.json();
        toast.error('Could not save key', err.error);
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to save key');
    } finally {
      setSavingProvider(null);
    }
  };

  const handleDelete = async (provider: ProviderKey) => {
    const ok = await confirm({
      title: 'Delete API key',
      message: `Delete the saved ${PROVIDER_COPY[provider].label} API key from this app? Environment variable keys are not affected.`,
      confirmLabel: 'Delete key',
      tone: 'danger'
    });
    if (!ok) return;

    setDeletingProvider(provider);
    try {
      const res = await fetch(`${API_BASE}/api/config/apikey`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider })
      });
      if (res.ok) {
        await fetchStatus();
        setApiKeys(prev => ({ ...prev, [provider]: '' }));
        toast.success(`${PROVIDER_COPY[provider].label} key deleted`);
      } else {
        const err = await res.json();
        toast.error('Could not delete key', err.error);
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to delete key');
    } finally {
      setDeletingProvider(null);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="App settings"
      icon={<Key className="w-4 h-4" />}
      widthClass="max-w-xl"
    >
      <div className="space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">AI configuration</h3>
        {isLoading ? (
          <div className="flex items-center gap-2 text-zinc-400 text-xs py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking providers...
          </div>
        ) : (
          <div className="space-y-3 max-h-[55vh] overflow-y-auto scrollbar-thin pr-1">
            {(['gemini', 'minimax'] as ProviderKey[]).map((provider) => {
              const providerStatus = status?.providers?.[provider];
              const proxyStatus = provider === 'minimax' ? status?.features?.minimaxProxy : null;
              const copy = PROVIDER_COPY[provider];
              const isManagedProxy = provider === 'minimax' && proxyStatus?.enabled;
              const isLockedByEnv = providerStatus?.source === 'env';
              const hasSavedKey = providerStatus?.source === 'db' || (provider === 'minimax' && proxyStatus?.localKeySource === 'db');
              const canSaveInSettings = provider === 'gemini' ? !isLockedByEnv : Boolean(proxyStatus?.allowClientKey) && !isLockedByEnv;
              const isReady = provider === 'minimax' ? Boolean(proxyStatus?.enabled) : Boolean(providerStatus?.configured);

              return (
                <div key={provider} className="rounded-xl border border-white/10 bg-ink-900/50 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-zinc-200">{copy.label}</span>
                    {isReady ? (
                      <div className="flex items-center gap-1.5 rounded-md border border-emerald-900/50 bg-emerald-900/20 px-2 py-0.5 text-xs text-emerald-400">
                        <CheckCircle className="w-3.5 h-3.5" />
                        {provider === 'minimax' && isManagedProxy
                          ? proxyStatus?.localKeyConfigured
                            ? `Proxy + Your Key (${proxyStatus.localKeySource === 'env' ? 'Environment' : 'Database'})`
                            : 'Proxy managed'
                          : `Configured (${providerStatus?.source === 'env' ? 'Environment' : 'Database'})`}
                      </div>
                    ) : (
                      <div className="rounded-md border border-amber-900/50 bg-amber-900/20 px-2 py-0.5 text-xs text-amber-400">Not configured</div>
                    )}
                  </div>

                  {provider === 'minimax' && proxyStatus?.enabled && (
                    <p className="text-xs text-zinc-400">
                      MiniMax always goes through the private ShellMind proxy.
                      {proxyStatus.allowClientKey ? ' You can optionally attach your own MiniMax key.' : ' Client MiniMax keys are disabled by the proxy policy.'}
                    </p>
                  )}

                  {isLockedByEnv ? (
                    <p className="flex items-center gap-1 text-xs italic text-zinc-400">
                      <Lock className="w-3.5 h-3.5" /> Managed via environment variables. Cannot be changed here.
                    </p>
                  ) : !canSaveInSettings ? (
                    <p className="flex items-center gap-1 text-xs italic text-zinc-400">
                      <Lock className="w-3.5 h-3.5" /> Saving {copy.label} keys from the app is disabled for this configuration.
                    </p>
                  ) : (
                    <form onSubmit={(e) => handleSave(e, provider)} className="space-y-2.5">
                      <PasswordInput
                        value={apiKeys[provider]}
                        onChange={(e) => setApiKeys(prev => ({ ...prev, [provider]: e.target.value }))}
                        placeholder={copy.placeholder}
                        required
                      />
                      <p className="text-xs text-zinc-500 flex items-center gap-1">
                        {copy.helpText}
                        <a href={copy.helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-400 hover:underline">
                          Open portal <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </p>
                      <div className="flex items-center justify-between gap-3">
                        {hasSavedKey ? (
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            loading={deletingProvider === provider}
                            disabled={savingProvider === provider}
                            onClick={() => handleDelete(provider)}
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </Button>
                        ) : <span />}
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          loading={savingProvider === provider}
                          disabled={deletingProvider === provider || !apiKeys[provider].trim()}
                        >
                          {hasSavedKey ? 'Update key' : 'Save key'}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {connError && <p className="text-xs text-rose-400">{connError}</p>}
      </div>
    </Modal>
  );
}
