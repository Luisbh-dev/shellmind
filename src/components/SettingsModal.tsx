import { useState, useEffect } from 'react';
import { X, Key, Loader2, CheckCircle, Lock } from 'lucide-react';
import { clsx } from 'clsx';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ configured: boolean, source: 'env' | 'db' | 'none' } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
      if (isOpen) {
          fetchStatus();
      }
  }, [isOpen]);

  const fetchStatus = async () => {
      setIsLoading(true);
      try {
          const res = await fetch('http://localhost:3001/api/config/status');
          const data = await res.json();
          setStatus(data);
      } catch (e) {
          console.error(e);
      } finally {
          setIsLoading(false);
      }
  };

  const handleSave = async (e: React.FormEvent) => {
      e.preventDefault();
      setIsSaving(true);
      try {
          const res = await fetch('http://localhost:3001/api/config/apikey', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: apiKey })
          });
          if (res.ok) {
              await fetchStatus();
              setApiKey('');
              alert("API Key saved successfully!");
          } else {
              const err = await res.json();
              alert("Error: " + err.error);
          }
      } catch (e) {
          console.error(e);
          alert("Failed to save key.");
      } finally {
          setIsSaving(false);
      }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[450px] bg-[#121212] border border-zinc-800 shadow-2xl rounded-lg overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-teal-500" />
                <span className="text-sm font-bold text-zinc-200 uppercase tracking-wide">App Settings</span>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
            </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
            
            {/* Status Section */}
            <div className="bg-zinc-900/30 border border-zinc-800 rounded-lg p-4">
                <h3 className="text-xs font-bold text-zinc-500 uppercase mb-3">AI Configuration Status</h3>
                {isLoading ? (
                    <div className="flex items-center gap-2 text-zinc-400 text-xs">
                        <Loader2 className="w-3 h-3 animate-spin" /> Checking...
                    </div>
                ) : (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-zinc-300">Gemini API Key</span>
                            {status?.configured ? (
                                <div className="flex items-center gap-1.5 text-emerald-400 text-xs bg-emerald-900/20 px-2 py-0.5 rounded border border-emerald-900/50">
                                    <CheckCircle className="w-3 h-3" />
                                    Configured ({status.source === 'env' ? 'Environment' : 'Database'})
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 text-amber-400 text-xs bg-amber-900/20 px-2 py-0.5 rounded border border-amber-900/50">
                                    Not Configured
                                </div>
                            )}
                        </div>
                        {status?.source === 'env' && (
                            <p className="text-[10px] text-zinc-500 italic flex items-center gap-1">
                                <Lock className="w-3 h-3" />
                                Managed via environment variables. Cannot be changed here.
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Input Section */}
            {status && status.source !== 'env' && (
                <form onSubmit={handleSave} className="space-y-4">
                    <div>
                        <label className="block text-[10px] uppercase text-zinc-500 font-bold mb-1">Set New API Key</label>
                        <input 
                            type="password" 
                            value={apiKey}
                            onChange={e => setApiKey(e.target.value)}
                            className="w-full bg-black border border-zinc-800 text-zinc-200 text-sm px-3 py-2 rounded focus:border-teal-600 focus:outline-none"
                            placeholder="AIzaSy..."
                            required
                        />
                        <p className="mt-1 text-[10px] text-zinc-600">
                            Get your key from <a href="https://aistudio.google.com/app/apikey" target="_blank" className="text-blue-400 hover:underline">Google AI Studio</a>.
                        </p>
                    </div>
                    
                    <div className="flex justify-end">
                        <button 
                            type="submit" 
                            disabled={isSaving || !apiKey}
                            className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold rounded flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                            Save Key
                        </button>
                    </div>
                </form>
            )}
        </div>
      </div>
    </div>
  );
}
