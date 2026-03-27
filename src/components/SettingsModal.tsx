import { useState, useEffect } from 'react';
import { X, Key, Loader2, CheckCircle, Lock } from 'lucide-react';

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
  const [apiKeys, setApiKeys] = useState<Record<ProviderKey, string>>({
    gemini: '',
    minimax: ''
  });
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ProviderKey | null>(null);
  const [connError, setConnError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
    }
  }, [isOpen]);

  const fetchStatus = async () => {
    setIsLoading(true);
    setConnError(null);
    try {
      const res = await fetch('http://localhost:3001/api/config/status');
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error(e);
      setConnError('Backend Server Disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent, provider: ProviderKey) => {
    e.preventDefault();
    setSavingProvider(provider);
    try {
      const res = await fetch('http://localhost:3001/api/config/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: apiKeys[provider] })
      });

      if (res.ok) {
        await fetchStatus();
        setApiKeys(prev => ({ ...prev, [provider]: '' }));
        alert(`${PROVIDER_COPY[provider].label} API Key saved successfully!`);
      } else {
        const err = await res.json();
        alert('Error: ' + err.error);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to save key.');
    } finally {
      setSavingProvider(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[520px] bg-[#121212] border border-zinc-800 shadow-2xl rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-teal-500" />
            <span className="text-sm font-bold text-zinc-200 uppercase tracking-wide">App Settings</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="bg-zinc-900/30 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-xs font-bold text-zinc-500 uppercase mb-3">AI Configuration Status</h3>
            {isLoading ? (
              <div className="flex items-center gap-2 text-zinc-400 text-xs">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking...
              </div>
            ) : (
              <div className="space-y-4">
                {(['gemini', 'minimax'] as ProviderKey[]).map((provider) => {
                  const providerStatus = status?.providers?.[provider];
                  const proxyStatus = provider === 'minimax' ? status?.features?.minimaxProxy : null;
                  const copy = PROVIDER_COPY[provider];
                  const isManagedProxy = provider === 'minimax' && proxyStatus?.enabled;
                  const isLockedByEnv = providerStatus?.source === 'env';
                  const canSaveInSettings = provider === 'gemini'
                    ? !isLockedByEnv
                    : Boolean(proxyStatus?.allowClientKey) && !isLockedByEnv;
                  const isReady = provider === 'minimax'
                    ? Boolean(proxyStatus?.enabled)
                    : Boolean(providerStatus?.configured);

                  return (
                    <div key={provider} className="rounded-lg border border-zinc-800 bg-black/30 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-zinc-300">{copy.label} API Key</span>
                        {isReady ? (
                          <div className="flex items-center gap-1.5 text-emerald-400 text-xs bg-emerald-900/20 px-2 py-0.5 rounded border border-emerald-900/50">
                            <CheckCircle className="w-3 h-3" />
                            {provider === 'minimax' && isManagedProxy
                              ? proxyStatus?.localKeyConfigured
                                ? `Proxy + Your Key (${proxyStatus.localKeySource === 'env' ? 'Environment' : 'Database'})`
                                : 'Proxy Managed'
                              : `Configured (${providerStatus?.source === 'env' ? 'Environment' : 'Database'})`}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-amber-400 text-xs bg-amber-900/20 px-2 py-0.5 rounded border border-amber-900/50">
                            Not Configured
                          </div>
                        )}
                      </div>

                      {provider === 'minimax' && proxyStatus?.enabled && (
                        <p className="text-[10px] text-zinc-500">
                          MiniMax always goes through the private ShellMind proxy.
                          {proxyStatus.allowClientKey
                            ? ' You can optionally attach your own MiniMax key from here.'
                            : ' Client MiniMax keys are currently disabled by the proxy policy.'}
                        </p>
                      )}

                      {isLockedByEnv ? (
                        <p className="text-[10px] text-zinc-500 italic flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          Managed via environment variables. Cannot be changed here.
                        </p>
                      ) : !canSaveInSettings ? (
                        <p className="text-[10px] text-zinc-500 italic flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          Saving {copy.label} keys from the app is disabled for this configuration.
                        </p>
                      ) : (
                        <form onSubmit={(e) => handleSave(e, provider)} className="space-y-3">
                          <div>
                            <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">
                              {provider === 'minimax' ? 'Set Optional Client Key' : 'Set New API Key'}
                            </label>
                            <input
                              type="password"
                              value={apiKeys[provider]}
                              onChange={e => setApiKeys(prev => ({ ...prev, [provider]: e.target.value }))}
                              className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-teal-600 focus:outline-none"
                              placeholder={copy.placeholder}
                              required
                            />
                            <p className="mt-1 text-[10px] text-zinc-600">
                              {copy.helpText} <a href={copy.helpUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open portal</a>.
                            </p>
                          </div>

                          <div className="flex justify-end">
                            <button
                              type="submit"
                              disabled={savingProvider === provider || !apiKeys[provider].trim()}
                              className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold rounded flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingProvider === provider && <Loader2 className="w-3 h-3 animate-spin" />}
                              Save {copy.label} Key
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {connError && (
              <p className="mt-3 text-[10px] text-red-400">{connError}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
