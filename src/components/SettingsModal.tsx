import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    AlertTriangle, Bot, CheckCircle, Database, ExternalLink, Info, Keyboard, KeyRound, Languages, Lock, Palette, RotateCcw, Settings2,
    ShieldCheck, Trash2
} from 'lucide-react';
import type { HealthResponse, ProviderStatus } from '@shared/types';
import { ApiError, api } from '@/lib/api';
import { APP_VERSION } from '@/lib/version';
import { useAppStore } from '@/store/appStore';
import { Trans } from '@/i18n/Trans';
import { LegalLink } from '@/components/LegalLink';
import { LANGUAGES, setLanguage, systemLanguage, useLanguagePreference, useT, type Language, type LanguagePreference } from '@/i18n';
import {
    Button, Field, Kbd, Modal, PasswordInput, Select, Spinner, TabPanel, Tabs, useConfirm, useToast
} from '@/components/ui';
import { DataTransfer } from '@/features/organization/DataTransfer';
import { AppearanceSettings } from '@/features/appearance/AppearanceSettings';
import { KeychainSettings } from '@/features/identities/KeychainSettings';
// --- W7-S1 fleet board ---
import { FleetSettings } from '@/features/fleet/FleetSettings';
import type { ShortcutGroup } from '@/features/palette/shortcutList';

export type SettingsSection = 'general' | 'appearance' | 'ai' | 'keychain' | 'data' | 'about';
const SECTIONS: SettingsSection[] = ['general', 'appearance', 'ai', 'keychain', 'data', 'about'];

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    // Section shown when the dialog opens.
    initialSection?: SettingsSection;
    // Every shortcut as displayed (e.g. "Ctrl+K"), in groups, listed under
    // General (features/palette/shortcutList.ts builds them).
    shortcutGroups: ShortcutGroup[];
    onServersImported: () => void;
    onOpenSshImport: () => void;
}

type ProviderKey = 'gemini' | 'minimax';
type SettingsStatus = {
    providers: Record<ProviderKey, ProviderStatus>;
    features?: {
        minimaxProxy?: {
            enabled: boolean;
            // How requests travel now: straight to MiniMax with the user's key,
            // or through the proxy. Older backends do not say (always the proxy).
            route?: 'direct' | 'proxy';
            baseUrl: string;
            apiBaseUrl?: string;
            allowClientKey: boolean;
            usesProxyAuth: boolean;
            localKeyConfigured: boolean;
            localKeySource: 'env' | 'db' | 'none';
        };
    };
};

const PROVIDER_COPY: Record<ProviderKey, { label: string; placeholder: string; helpUrl: string }> = {
    gemini: { label: 'Gemini', placeholder: 'AIzaSy...', helpUrl: 'https://aistudio.google.com/app/apikey' },
    minimax: { label: 'MiniMax', placeholder: 'sk-...', helpUrl: 'https://platform.minimax.io/' }
};

// Language names are shown in their own language, whatever the UI language.
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', es: 'Español' };

const SECTION_ICONS: Record<SettingsSection, React.ReactNode> = {
    general: <Settings2 className="h-4 w-4" />,
    appearance: <Palette className="h-4 w-4" />,
    ai: <Bot className="h-4 w-4" />,
    keychain: <KeyRound className="h-4 w-4" />,
    data: <Database className="h-4 w-4" />,
    about: <Info className="h-4 w-4" />
};


function SectionHeading({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
    return (
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
            {icon && <span aria-hidden="true">{icon}</span>}
            {children}
        </h3>
    );
}

export default function SettingsModal({
    isOpen, onClose, initialSection = 'general', shortcutGroups, onServersImported, onOpenSshImport
}: SettingsModalProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const languagePreference = useLanguagePreference();
    const [section, setSection] = useState<SettingsSection>(initialSection);
    const [apiKeys, setApiKeys] = useState<Record<ProviderKey, string>>({ gemini: '', minimax: '' });
    const [status, setStatus] = useState<SettingsStatus | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [savingProvider, setSavingProvider] = useState<ProviderKey | null>(null);
    const [deletingProvider, setDeletingProvider] = useState<ProviderKey | null>(null);
    // The backend's version, shown when it is not this build's (a self-hosted
    // UI talking to an older or newer server).
    const [backendVersion, setBackendVersion] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const fetchStatus = useCallback(async () => {
        setIsLoading(true);
        setStatusError(null);
        try {
            setStatus(await api.get<SettingsStatus>('/api/config/status'));
        } catch (e) {
            setStatus(null);
            setStatusError(e instanceof ApiError ? e.message : String(e));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        setSection(initialSection);
        void fetchStatus();
        api.get<HealthResponse>('/api/health').then((health) => setBackendVersion(health.version ?? null), () => setBackendVersion(null));
    }, [isOpen, initialSection, fetchStatus]);

    // The sections share one scroll area: each starts at its top, not where
    // the previous (longer) one was left.
    useLayoutEffect(() => {
        if (panelRef.current) panelRef.current.scrollTop = 0;
    }, [section]);

    const sourceLabel = (source: 'env' | 'db' | 'none' | undefined) =>
        t(source === 'env' ? 'settings.ai.source.env' : 'settings.ai.source.db');

    const handleSave = async (e: React.FormEvent, provider: ProviderKey) => {
        e.preventDefault();
        setSavingProvider(provider);
        try {
            await api.post('/api/config/apikey', { provider, key: apiKeys[provider] });
            useAppStore.getState().aiConfigChanged();
            await fetchStatus();
            setApiKeys((prev) => ({ ...prev, [provider]: '' }));
            toast.success(t('settings.ai.saved', { provider: PROVIDER_COPY[provider].label }));
        } catch (e) {
            if (e instanceof ApiError && !e.isNetworkError) toast.error(t('settings.ai.saveFailed'), e.message);
            else toast.error(t('settings.ai.saveError'));
        } finally {
            setSavingProvider(null);
        }
    };

    const handleDelete = async (provider: ProviderKey) => {
        const ok = await confirm({
            title: t('settings.ai.deleteDialog.title'),
            message: t('settings.ai.deleteDialog.message', { provider: PROVIDER_COPY[provider].label }),
            confirmLabel: t('settings.ai.deleteDialog.confirm'),
            tone: 'danger'
        });
        if (!ok) return;

        setDeletingProvider(provider);
        try {
            await api.del('/api/config/apikey', { provider });
            useAppStore.getState().aiConfigChanged();
            await fetchStatus();
            setApiKeys((prev) => ({ ...prev, [provider]: '' }));
            toast.success(t('settings.ai.deleted', { provider: PROVIDER_COPY[provider].label }));
        } catch (e) {
            if (e instanceof ApiError && !e.isNetworkError) toast.error(t('settings.ai.deleteFailed'), e.message);
            else toast.error(t('settings.ai.deleteError'));
        } finally {
            setDeletingProvider(null);
        }
    };

    const languageOptions = [
        { value: 'system', label: t('settings.language.system', { language: LANGUAGE_NAMES[systemLanguage()] }) },
        ...LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] }))
    ];

    const renderProvider = (provider: ProviderKey) => {
        const providerStatus = status?.providers?.[provider];
        const proxyStatus = provider === 'minimax' ? status?.features?.minimaxProxy : null;
        const copy = PROVIDER_COPY[provider];
        const isManagedProxy = provider === 'minimax' && proxyStatus?.enabled && proxyStatus.route !== 'direct';
        const isLockedByEnv = providerStatus?.source === 'env';
        const hasSavedKey = providerStatus?.source === 'db' || (provider === 'minimax' && proxyStatus?.localKeySource === 'db');
        const canSaveInSettings = provider === 'gemini' ? !isLockedByEnv : Boolean(proxyStatus?.allowClientKey) && !isLockedByEnv;
        const isReady = provider === 'minimax' ? Boolean(proxyStatus?.enabled) : Boolean(providerStatus?.configured);
        const keyInputId = `settings-key-${provider}`;

        return (
            <section key={provider} aria-labelledby={`${keyInputId}-title`} className="rounded-xl border border-white/10 bg-ink-900/50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <h4 id={`${keyInputId}-title`} className="text-sm font-medium text-zinc-100">{copy.label}</h4>
                    {isReady ? (
                        <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                            <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />
                            {isManagedProxy
                                ? proxyStatus?.localKeyConfigured
                                    ? t('settings.ai.proxyWithKey', { source: sourceLabel(proxyStatus.localKeySource) })
                                    : t('settings.ai.proxyManaged')
                                : t('settings.ai.configured', { source: sourceLabel(proxyStatus?.localKeySource ?? providerStatus?.source) })}
                        </span>
                    ) : (
                        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">{t('settings.ai.notConfigured')}</span>
                    )}
                </div>

                {provider === 'minimax' && proxyStatus?.enabled ? (
                    <div className="flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-100">
                        <Info className="mt-px h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
                        <p>
                            {proxyStatus.route === 'direct'
                                ? t('settings.ai.minimaxDirect')
                                : <Trans k="settings.ai.minimaxViaProxy" values={{ legal: <LegalLink label={t('settings.ai.legalLink')} className="text-sky-50" /> }} />}
                            {!proxyStatus.allowClientKey
                                ? ` ${t('settings.ai.minimaxClientKeyDisabled')}`
                                : proxyStatus.route === 'proxy'
                                    ? ` ${t('settings.ai.minimaxClientKeyDirect')}`
                                    : proxyStatus.route === undefined ? ` ${t('settings.ai.minimaxClientKeyAllowed')}` : ''}
                        </p>
                    </div>
                ) : provider === 'gemini' ? (
                    <p className="text-xs text-zinc-400">{t('settings.ai.geminiDisclosure')}</p>
                ) : null}

                {isLockedByEnv ? (
                    <p className="flex items-center gap-1 text-xs italic text-zinc-400">
                        <Lock className="w-3.5 h-3.5" aria-hidden="true" /> {t('settings.ai.lockedByEnv')}
                    </p>
                ) : !canSaveInSettings ? (
                    <p className="flex items-center gap-1 text-xs italic text-zinc-400">
                        <Lock className="w-3.5 h-3.5" aria-hidden="true" /> {t('settings.ai.savingDisabled', { provider: copy.label })}
                    </p>
                ) : (
                    <form onSubmit={(e) => void handleSave(e, provider)} className="space-y-2.5">
                        <Field
                            label={t('settings.ai.keyLabel', { provider: copy.label })}
                            hint={<>
                                {t(`settings.ai.help.${provider}`)}{' '}
                                <a href={copy.helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-300 hover:underline focus-ring rounded">
                                    {t('settings.ai.openPortal')} <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
                                </a>
                            </>}
                        >
                            <PasswordInput
                                value={apiKeys[provider]}
                                onChange={(e) => setApiKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                                placeholder={hasSavedKey ? t('settings.ai.keyPlaceholderSaved') : copy.placeholder}
                                autoComplete="off"
                                required
                            />
                        </Field>
                        <div className="flex items-center justify-between gap-3">
                            {hasSavedKey ? (
                                <Button
                                    type="button"
                                    variant="danger"
                                    size="sm"
                                    loading={deletingProvider === provider}
                                    disabled={savingProvider === provider}
                                    onClick={() => void handleDelete(provider)}
                                >
                                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('settings.ai.delete')}
                                </Button>
                            ) : <span />}
                            <Button
                                type="submit"
                                variant="primary"
                                size="sm"
                                loading={savingProvider === provider}
                                disabled={deletingProvider === provider || !apiKeys[provider].trim()}
                            >
                                {hasSavedKey ? t('settings.ai.updateKey') : t('settings.ai.saveKey')}
                            </Button>
                        </div>
                    </form>
                )}
            </section>
        );
    };

    const renderAi = () => {
        if (isLoading && !status) {
            return (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-400" role="status">
                    <Spinner className="h-4 w-4" /> {t('settings.ai.checking')}
                </div>
            );
        }
        if (statusError) {
            // Never "Not configured" when the truth is "could not ask".
            return (
                <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-sm text-rose-100">
                    <p className="flex items-center gap-2 font-medium">
                        <AlertTriangle className="h-4 w-4 text-rose-300" aria-hidden="true" /> {t('settings.ai.statusUnavailable')}
                    </p>
                    <p className="mt-1 break-words text-xs text-rose-200/80">{statusError}</p>
                    <Button size="sm" variant="secondary" className="mt-3" onClick={() => void fetchStatus()} loading={isLoading}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.retry')}
                    </Button>
                </div>
            );
        }
        return <div className="space-y-3">{(['gemini', 'minimax'] as ProviderKey[]).map(renderProvider)}</div>;
    };

    return (
        <Modal
            open={isOpen}
            onClose={onClose}
            title={t('settings.title')}
            icon={<Settings2 className="w-4 h-4" />}
            widthClass="max-w-3xl"
            bodyClassName="p-0"
        >
            {/* Fixed height: switching sections does not resize (and move) the dialog. */}
            <div className="grid h-[min(34rem,calc(100vh-9rem))] grid-cols-[11rem_minmax(0,1fr)]">
                <div className="border-r border-white/5 p-3">
                    <Tabs
                        idPrefix="settings"
                        aria-label={t('settings.sectionsLabel')}
                        orientation="vertical"
                        value={section}
                        onChange={(id) => setSection(id as SettingsSection)}
                        items={SECTIONS.map((id) => ({ id, label: t(`settings.sections.${id}`), icon: SECTION_ICONS[id] }))}
                    />
                </div>
                <div ref={panelRef} className="min-w-0 overflow-y-auto scrollbar-thin p-5">
                    <TabPanel idPrefix="settings" id="general" active={section === 'general'} className="space-y-6">
                        <div className="space-y-2">
                            <Field label={<span className="inline-flex items-center gap-1.5"><Languages className="h-3.5 w-3.5" aria-hidden="true" />{t('settings.language.heading')}</span>} hint={t('settings.language.description')}>
                                <Select
                                    value={languagePreference}
                                    onChange={(value) => setLanguage(value as LanguagePreference)}
                                    options={languageOptions}
                                />
                            </Field>
                        </div>
                        {/* --- W7-S1 fleet board --- */}
                        <FleetSettings />

                        <div className="space-y-3">
                            <SectionHeading icon={<Keyboard className="h-3.5 w-3.5" />}>{t('settings.shortcuts.heading')}</SectionHeading>
                            {shortcutGroups.map((group) => (
                                <section key={group.id} aria-labelledby={`settings-shortcuts-${group.id}`} className="space-y-1.5">
                                    <h4 id={`settings-shortcuts-${group.id}`} className="text-xs font-medium text-zinc-400">{group.title}</h4>
                                    <dl className="divide-y divide-white/5 rounded-lg border border-white/5">
                                        {group.items.map((shortcut) => (
                                            <div key={shortcut.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                                                <dt className="text-zinc-300">{shortcut.label}</dt>
                                                <dd className="shrink-0"><Kbd>{shortcut.keys}</Kbd></dd>
                                            </div>
                                        ))}
                                    </dl>
                                </section>
                            ))}
                        </div>
                    </TabPanel>

                    <TabPanel idPrefix="settings" id="appearance" active={section === 'appearance'}>
                        <AppearanceSettings />
                    </TabPanel>

                    <TabPanel idPrefix="settings" id="ai" active={section === 'ai'} className="space-y-3">
                        <SectionHeading>{t('settings.ai.heading')}</SectionHeading>
                        {renderAi()}
                    </TabPanel>

                    <TabPanel idPrefix="settings" id="keychain" active={section === 'keychain'}>
                        <KeychainSettings />
                    </TabPanel>

                    <TabPanel idPrefix="settings" id="data" active={section === 'data'} className="space-y-6">
                        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                            <div className="space-y-1 text-xs text-zinc-300">
                                <p className="text-sm font-medium text-zinc-100">{t('settings.data.encryptedTitle')}</p>
                                <p>{t('settings.data.encryptedBody')}</p>
                            </div>
                        </div>
                        <DataTransfer onImported={onServersImported} onOpenSshImport={onOpenSshImport} />
                    </TabPanel>

                    <TabPanel idPrefix="settings" id="about" active={section === 'about'} className="space-y-4">
                        <div>
                            <p className="text-lg font-semibold text-zinc-100">ShellMind</p>
                            <p className="text-sm text-zinc-400">{t('settings.about.version', { version: APP_VERSION })}</p>
                            {backendVersion && backendVersion !== APP_VERSION && (
                                <p className="text-xs text-zinc-400">{t('settings.about.backendVersion', { version: backendVersion })}</p>
                            )}
                        </div>
                        <p className="text-sm text-zinc-300">{t('settings.about.description')}</p>
                        <p className="text-xs text-zinc-400">{t('settings.about.license')}</p>
                        <a
                            href="https://github.com/Luisbh-dev/shellmind"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded text-sm text-brand-300 hover:underline focus-ring"
                        >
                            {t('settings.about.source')} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                    </TabPanel>
                </div>
            </div>
        </Modal>
    );
}
