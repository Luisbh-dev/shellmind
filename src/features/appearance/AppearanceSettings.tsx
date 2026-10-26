import { useRef } from 'react';
import { Minus, Monitor, Moon, Plus, RotateCcw, Rows3, Rows4, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { Button, Checkbox, Field, IconButton, SegmentedControl, useFieldContext, useToast } from '@/components/ui';
import { rovingIndex } from '@/components/ui/focus';
import { useTerminalPrefs } from '@/features/terminal/preferences';
import {
    ACCENTS, ACCENT_COLORS, CURSOR_STYLES, DENSITIES, TERMINAL_FONT_SIZE, TERMINAL_THEME_IDS, THEME_PREFERENCES,
    type CursorStyle, type ResolvedTheme, type TerminalThemeId, type ThemePreference
} from './model';
import { useAppearance, useAppearancePrefs, useResolvedTheme } from './store';
import { terminalScheme, type TerminalScheme } from './terminalThemes';

// Miniature of the app window in a theme (decorative).
const MINIATURE: Record<ResolvedTheme, { frame: string; side: string; main: string; line: string }> = {
    dark: { frame: '#0b0d11', side: '#13161c', main: '#08090c', line: '#3f3f46' },
    light: { frame: '#f4f5f7', side: '#eceef1', main: '#ffffff', line: '#d4d4d8' }
};

function Miniature({ theme, accent }: { theme: ResolvedTheme; accent: string }) {
    const colors = MINIATURE[theme];
    return (
        <g>
            <rect width="72" height="44" rx="5" fill={colors.frame} />
            <rect x="0" y="7" width="20" height="37" fill={colors.side} />
            <rect x="20" y="7" width="52" height="37" fill={colors.main} />
            <rect x="4" y="12" width="12" height="3" rx="1.5" fill={accent} />
            <rect x="4" y="19" width="10" height="2" rx="1" fill={colors.line} />
            <rect x="4" y="24" width="12" height="2" rx="1" fill={colors.line} />
            <rect x="25" y="12" width="26" height="3" rx="1.5" fill={colors.line} />
            <rect x="25" y="19" width="40" height="2" rx="1" fill={colors.line} />
            <rect x="25" y="24" width="34" height="2" rx="1" fill={colors.line} />
            <rect x="25" y="33" width="14" height="5" rx="2" fill={accent} />
        </g>
    );
}

function ThemePreview({ preference, accent }: { preference: ThemePreference; accent: (theme: ResolvedTheme) => string }) {
    return (
        <svg width="72" height="44" viewBox="0 0 72 44" aria-hidden="true" className="rounded-md shadow-soft">
            {preference === 'system' ? (
                <>
                    <defs>
                        <clipPath id="appearance-preview-half">
                            <path d="M0 0 H72 L0 44 Z" />
                        </clipPath>
                    </defs>
                    <Miniature theme="dark" accent={accent('dark')} />
                    <g clipPath="url(#appearance-preview-half)">
                        <Miniature theme="light" accent={accent('light')} />
                    </g>
                </>
            ) : <Miniature theme={preference} accent={accent(preference)} />}
            <rect x="0.5" y="0.5" width="71" height="43" rx="4.5" fill="none" stroke="currentColor" strokeOpacity="0.15" />
        </svg>
    );
}

// A few lines of a shell session in a colour scheme.
function SchemeSample({ scheme, cursor = 'block', blink = false, fontSize }: {
    scheme: TerminalScheme;
    cursor?: CursorStyle;
    blink?: boolean;
    fontSize?: number;
}) {
    const { theme } = scheme;
    const cursorClass = cursor === 'block' ? 'h-[1.15em] w-[0.6em]' : cursor === 'bar' ? 'h-[1.15em] w-[2px]' : 'h-[2px] w-[0.6em] self-end mb-[0.1em]';
    return (
        <div className="font-mono leading-[1.35]" style={{ background: theme.background, color: theme.foreground, fontSize }}>
            <div className="truncate">
                <span style={{ color: theme.green }}>ops@web-01</span>
                <span style={{ color: theme.foreground }}>:</span>
                <span style={{ color: theme.blue }}>~</span>$ ls
            </div>
            <div className="truncate">
                <span style={{ color: theme.blue }}>logs</span>{'  '}
                <span style={{ color: theme.cyan }}>app.sock</span>{'  '}
                <span style={{ color: theme.green }}>deploy.sh</span>
            </div>
            <div className="truncate">
                <span style={{ color: theme.red }}>error</span>{' '}
                <span style={{ color: theme.yellow }}>warn</span>{' '}
                <span style={{ color: theme.magenta }}>info</span>{' '}
                <span style={{ color: theme.brightBlack }}>debug</span>
            </div>
            <div className="flex items-center">
                <span style={{ color: theme.green }}>ops@web-01</span>
                <span>:</span>
                <span style={{ color: theme.blue }}>~</span>$&nbsp;
                <span className={cn('inline-block shrink-0', cursorClass, blink && 'animate-pulse')} style={{ background: theme.cursor }} />
            </div>
        </div>
    );
}

function TerminalSchemePicker({ value, onChange }: { value: TerminalThemeId; onChange: (id: TerminalThemeId) => void }) {
    const t = useT();
    const field = useFieldContext();
    const resolved = useResolvedTheme();
    const { accent } = useAppearancePrefs();
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const selectedIndex = TERMINAL_THEME_IDS.indexOf(value);

    const onKeyDown = (event: React.KeyboardEvent, index: number) => {
        const next = rovingIndex(event.key, index, TERMINAL_THEME_IDS.length);
        if (next === null) return;
        event.preventDefault();
        onChange(TERMINAL_THEME_IDS[next]);
        refs.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-labelledby={field?.labelId} aria-describedby={field?.describedBy} className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
            {TERMINAL_THEME_IDS.map((id, index) => {
                const checked = id === value;
                const scheme = id === 'auto'
                    ? terminalScheme(resolved === 'light' ? 'shellmind-light' : 'shellmind-dark', accent)
                    : terminalScheme(id, accent);
                const name = id === 'auto' ? t('appearance.terminalTheme.auto') : scheme.name;
                return (
                    <button
                        key={id}
                        ref={(element) => { refs.current[index] = element; }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked || (selectedIndex === -1 && index === 0) ? 0 : -1}
                        title={id === 'auto' ? t('appearance.terminalTheme.autoHint') : undefined}
                        onClick={() => onChange(id)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn(
                            'group overflow-hidden rounded-xl border text-left transition focus-ring',
                            checked ? 'border-brand-500/70 ring-1 ring-brand-500/40' : 'border-white/10 hover:border-white/20'
                        )}
                    >
                        <div className="px-2.5 py-2 text-[10.5px]" style={{ background: scheme.theme.background }}>
                            <SchemeSample scheme={scheme} />
                        </div>
                        <div className={cn('flex items-center justify-between gap-2 border-t border-white/5 px-2.5 py-1.5 text-xs font-medium', checked ? 'bg-brand-500/10 text-brand-200' : 'bg-white/[0.02] text-zinc-300')}>
                            <span className="truncate">{name}</span>
                            {id === 'auto' && <span className="shrink-0 text-[10px] font-normal text-zinc-400">{t(`appearance.theme.${scheme.kind}`)}</span>}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

const CURSOR_GLYPH: Record<CursorStyle, string> = {
    block: 'h-3.5 w-2 bg-current',
    bar: 'h-3.5 w-0.5 bg-current',
    underline: 'mt-3 h-0.5 w-2 bg-current'
};

// Slider with − / + steps; the Field's label names the slider.
function FontSizeControl({ value, onChange }: { value: number; onChange: (size: number) => void }) {
    const t = useT();
    const field = useFieldContext();
    const text = t('appearance.fontSize.value', { size: value });
    return (
        <div className="flex items-center gap-2">
            <IconButton
                size="sm"
                label={t('appearance.fontSize.smaller')}
                disabled={value <= TERMINAL_FONT_SIZE.min}
                onClick={() => onChange(value - 1)}
            >
                <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
            <input
                id={field?.id}
                aria-describedby={field?.describedBy}
                type="range"
                min={TERMINAL_FONT_SIZE.min}
                max={TERMINAL_FONT_SIZE.max}
                step={1}
                value={value}
                aria-valuetext={text}
                onChange={(event) => onChange(Number(event.target.value))}
                className="h-1.5 min-w-0 flex-1 cursor-pointer rounded-full accent-brand-500 focus-ring"
            />
            <IconButton
                size="sm"
                label={t('appearance.fontSize.larger')}
                disabled={value >= TERMINAL_FONT_SIZE.max}
                onClick={() => onChange(value + 1)}
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
            <output htmlFor={field?.id} className="w-11 shrink-0 text-right font-mono text-xs text-zinc-300">{text}</output>
        </div>
    );
}

function SubHeading({ children }: { children: React.ReactNode }) {
    return <h3 className="text-sm font-semibold text-zinc-100">{children}</h3>;
}

export function AppearanceSettings() {
    const t = useT();
    const toast = useToast();
    const prefs = useAppearancePrefs();
    // A preference of this device's terminals (features/terminal/preferences.ts),
    // not of the theme: Reset appearance leaves it.
    const screenReaderMode = useTerminalPrefs((terminal) => terminal.screenReaderMode);
    const setScreenReaderMode = useTerminalPrefs((terminal) => terminal.setScreenReaderMode);
    const resolved = useResolvedTheme();
    const setAppearance = useAppearance((state) => state.setAppearance);
    const resetAppearance = useAppearance((state) => state.resetAppearance);
    const preview = terminalScheme(prefs.terminalTheme === 'auto' ? (resolved === 'light' ? 'shellmind-light' : 'shellmind-dark') : prefs.terminalTheme, prefs.accent);
    const fontSize = prefs.terminalFontSize;

    const themeIcons: Record<ThemePreference, React.ReactNode> = {
        system: <Monitor className="h-3.5 w-3.5" />,
        light: <Sun className="h-3.5 w-3.5" />,
        dark: <Moon className="h-3.5 w-3.5" />
    };

    return (
        <div className="space-y-8">
            <section className="space-y-5" aria-labelledby="appearance-interface">
                <div id="appearance-interface"><SubHeading>{t('appearance.interface')}</SubHeading></div>
                <Field group label={t('appearance.theme.label')} hint={t('appearance.theme.hint', { current: t(`appearance.theme.${resolved}`).toLowerCase() })}>
                    <SegmentedControl
                        variant="cards"
                        value={prefs.theme}
                        onChange={(theme) => setAppearance({ theme })}
                        options={THEME_PREFERENCES.map((preference) => ({
                            value: preference,
                            icon: <ThemePreview preference={preference} accent={(theme) => ACCENT_COLORS[prefs.accent][theme]} />,
                            label: <span className="inline-flex items-center gap-1.5">{themeIcons[preference]}{t(`appearance.theme.${preference}`)}</span>
                        }))}
                    />
                </Field>

                <Field group label={t('appearance.accent.label')} hint={t('appearance.accent.hint')}>
                    <SegmentedControl
                        variant="cards"
                        value={prefs.accent}
                        onChange={(accent) => setAppearance({ accent })}
                        options={ACCENTS.map((accent) => ({
                            value: accent,
                            icon: (
                                <span
                                    className="block h-5 w-5 rounded-full ring-2 ring-white/10 ring-offset-2 ring-offset-ink-800"
                                    style={{ background: ACCENT_COLORS[accent][resolved] }}
                                />
                            ),
                            label: t(`appearance.accent.${accent}`)
                        }))}
                    />
                </Field>

                <Field group label={t('appearance.density.label')} hint={t('appearance.density.hint')}>
                    <SegmentedControl
                        value={prefs.density}
                        onChange={(density) => setAppearance({ density })}
                        options={DENSITIES.map((density) => ({
                            value: density,
                            icon: density === 'compact' ? <Rows4 className="h-3.5 w-3.5" /> : <Rows3 className="h-3.5 w-3.5" />,
                            label: t(`appearance.density.${density}`)
                        }))}
                    />
                </Field>
            </section>

            <section className="space-y-5" aria-labelledby="appearance-terminal">
                <div id="appearance-terminal"><SubHeading>{t('appearance.terminal')}</SubHeading></div>

                <figure className="overflow-hidden rounded-xl border border-white/10" aria-label={t('appearance.preview')}>
                    <div className="max-h-40 overflow-hidden px-4 py-3" style={{ background: preview.theme.background }}>
                        <SchemeSample scheme={preview} cursor={prefs.cursorStyle} blink={prefs.cursorBlink} fontSize={fontSize} />
                    </div>
                </figure>

                <Field group label={t('appearance.terminalTheme.label')}>
                    <TerminalSchemePicker value={prefs.terminalTheme} onChange={(terminalTheme) => setAppearance({ terminalTheme })} />
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                    <Field label={t('appearance.fontSize.label')}>
                        <FontSizeControl value={fontSize} onChange={(terminalFontSize) => setAppearance({ terminalFontSize })} />
                    </Field>

                    <Field group label={t('appearance.cursor.label')}>
                        <SegmentedControl
                            value={prefs.cursorStyle}
                            onChange={(cursorStyle) => setAppearance({ cursorStyle })}
                            options={CURSOR_STYLES.map((style) => ({
                                value: style,
                                icon: <span className={cn('inline-block', CURSOR_GLYPH[style])} />,
                                label: t(`appearance.cursor.${style}`)
                            }))}
                        />
                    </Field>
                </div>

                <Checkbox
                    checked={prefs.cursorBlink}
                    onChange={(cursorBlink) => setAppearance({ cursorBlink })}
                    label={t('appearance.cursor.blink')}
                />

                <Checkbox
                    checked={screenReaderMode}
                    onChange={setScreenReaderMode}
                    label={t('appearance.screenReader.label')}
                    description={t('appearance.screenReader.hint')}
                />
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4">
                <p className="text-xs text-zinc-400">{t('appearance.motion')}</p>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        resetAppearance();
                        toast.success(t('appearance.resetDone'));
                    }}
                >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t('appearance.reset')}
                </Button>
            </div>
        </div>
    );
}
