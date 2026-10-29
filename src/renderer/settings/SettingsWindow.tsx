import { useEffect, useMemo, useState } from 'react';
import {
    settingsPreferencesSchema,
    type ConnectionTestResult,
    type ProviderDetails,
    type ProviderSaveConfig,
    type ProviderSummary,
    type SettingsPreferences
} from '../../shared/contracts';

export interface SettingsError {
    code: string;
    message: string;
}

export interface SettingsWindowProps {
    providers?: ProviderSummary[];
    activeProviderId?: string;
    preferences?: SettingsPreferences;
    error?: SettingsError;
    onSaveProvider?: (provider: ProviderSaveConfig) => Promise<ProviderSummary> | void;
    onDeleteProvider?: (providerId: string) => Promise<void> | void;
    onSelectProvider?: (providerId: string) => Promise<void> | void;
    onTestProvider?: (
        providerId: string,
        capability: 'text' | 'vision'
    ) => Promise<ConnectionTestResult> | ConnectionTestResult | void;
    onSavePreferences?: (preferences: SettingsPreferences) => Promise<unknown> | void;
}

interface SettingsDesktopPetApi {
    getProviderSummaries: () => Promise<ProviderSummary[]>;
    getProviderDetails: (providerId: string) => Promise<ProviderDetails>;
    getSettings: () => Promise<{ activeProviderId?: string; preferences: SettingsPreferences }>;
    saveProvider: (provider: ProviderSaveConfig) => Promise<ProviderSummary>;
    deleteProvider: (providerId: string) => Promise<void>;
    setActiveProvider: (providerId: string) => Promise<void>;
    testProvider: (
        providerId: string,
        capability: 'text' | 'vision'
    ) => Promise<ConnectionTestResult>;
    saveSettings: (preferences: SettingsPreferences) => Promise<unknown>;
}

function getDesktopPetApi(): SettingsDesktopPetApi | undefined {
    return typeof window === 'undefined'
        ? undefined
        : (window as unknown as { desktopPet?: SettingsDesktopPetApi }).desktopPet;
}

export interface HotkeyEventLike {
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    key: string;
}

export interface HotkeyValidation {
    valid: boolean;
    value?: string;
    error?: string;
}

const defaultPreferences: SettingsPreferences = settingsPreferencesSchema.parse({
    hotkey: 'Ctrl+Shift+T',
    privacy: {
        localOnly: true,
        saveTranslationHistory: false,
        restoreClipboard: true
    },
    performance: {
        reduceMotion: false,
        pauseWhenFullscreen: true,
        limitFrameRate: true
    }
});

export function maskSecret(secret: string): string {
    return secret.length === 0 ? 'Not set' : '••••••••';
}

function normalizeKey(value: string): string {
    if (value.length === 1)
        return value.toUpperCase();
    return value;
}

export function hotkeyFromEvent(event: HotkeyEventLike): string {
    const modifiers = [
        event.ctrlKey ? 'Ctrl' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
        event.metaKey ? 'Meta' : ''
    ].filter(Boolean);
    return [...modifiers, normalizeKey(event.key)].join('+');
}

export function validateHotkey(value: string | HotkeyEventLike): HotkeyValidation {
    const hotkey = typeof value === 'string' ? value : hotkeyFromEvent(value);
    const parts = hotkey.split('+').map((part) => part.trim()).filter(Boolean);
    const modifiers = new Set(parts.slice(0, -1));
    const key = parts.at(-1);
    const validModifiers = ['Alt', 'Ctrl', 'Meta', 'Shift'];
    const valid = parts.length >= 2
        && key !== undefined
        && !validModifiers.includes(key)
        && parts.slice(0, -1).every((part) => validModifiers.includes(part))
        && modifiers.size === parts.length - 1;
    return valid
        ? { valid: true, value: parts.join('+') }
        : {
            valid: false,
            error: 'Use one or more modifiers plus exactly one key.'
        };
}

interface ProviderForm {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    textModel: string;
    visionModel: string;
    systemPrompt: string;
    targetLanguage: string;
    timeoutMs: string;
    streaming: boolean;
}

function emptyProviderForm(): ProviderForm {
    return {
        name: '',
        baseUrl: '',
        apiKey: '',
        textModel: '',
        visionModel: '',
        systemPrompt: '',
        targetLanguage: 'en',
        timeoutMs: '30000',
        streaming: true
    };
}

function providerToForm(provider: ProviderSummary): ProviderForm {
    return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: '',
        textModel: provider.textModel,
        visionModel: provider.visionModel,
        systemPrompt: '',
        targetLanguage: 'en',
        timeoutMs: '30000',
        streaming: true
    };
}

function applyProviderDetails(form: ProviderForm, details: ProviderDetails): ProviderForm {
    return {
        ...form,
        id: details.id,
        name: details.name,
        baseUrl: details.baseUrl,
        textModel: details.textModel,
        visionModel: details.visionModel,
        systemPrompt: details.systemPrompt ?? '',
        targetLanguage: details.targetLanguage ?? 'en',
        timeoutMs: String(details.timeoutMs ?? 30_000),
        streaming: details.streaming ?? true
    };
}

function toProviderSaveConfig(form: ProviderForm): ProviderSaveConfig {
    return {
        ...(form.id === undefined ? {} : { id: form.id }),
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
        textModel: form.textModel.trim(),
        visionModel: form.visionModel.trim(),
        ...(form.systemPrompt.length === 0 ? {} : { systemPrompt: form.systemPrompt }),
        targetLanguage: form.targetLanguage.trim(),
        timeoutMs: Number(form.timeoutMs),
        streaming: form.streaming
    };
}

export default function SettingsWindow({
    providers: providedProviders,
    activeProviderId: providedActiveProviderId,
    preferences: providedPreferences,
    error: providedError,
    onSaveProvider,
    onDeleteProvider,
    onSelectProvider,
    onTestProvider,
    onSavePreferences
}: SettingsWindowProps): React.JSX.Element {
    const [providers, setProviders] = useState<ProviderSummary[]>(providedProviders ?? []);
    const [activeProviderId, setActiveProviderId] = useState(
        providedActiveProviderId ?? providedProviders?.[0]?.id ?? ''
    );
    const [preferences, setPreferences] = useState<SettingsPreferences>(
        providedPreferences ?? defaultPreferences
    );
    const [form, setForm] = useState<ProviderForm>(
        providedProviders?.find((provider) => provider.id === activeProviderId)
            ? providerToForm(providers.find((provider) => provider.id === activeProviderId)!)
            : emptyProviderForm()
    );
    const [error, setError] = useState<SettingsError | undefined>(providedError);
    const [testResult, setTestResult] = useState<ConnectionTestResult>();
    const [hotkeyDraft, setHotkeyDraft] = useState(preferences.hotkey);
    const desktopPet = getDesktopPetApi();

    useEffect(() => {
        if (providedProviders !== undefined)
            setProviders(providedProviders);
    }, [providedProviders]);

    useEffect(() => {
        if (providedError !== undefined)
            setError(providedError);
    }, [providedError]);

    useEffect(() => {
        if (providedProviders !== undefined || desktopPet === undefined)
            return;
        void desktopPet.getProviderSummaries()
            .then((summaries) => {
                setProviders(summaries);
                const nextActive = summaries[0]?.id ?? '';
                setActiveProviderId(nextActive);
                setForm(summaries[0] === undefined
                    ? emptyProviderForm()
                    : providerToForm(summaries[0]));
            })
            .catch((caught: unknown) => setError(toSettingsError(caught)));
    }, [desktopPet, providedProviders]);

    useEffect(() => {
        if (providedPreferences !== undefined || desktopPet === undefined)
            return;
        void desktopPet.getSettings()
            .then((settings) => {
                setPreferences(settings.preferences);
                setHotkeyDraft(settings.preferences.hotkey);
                if (settings.activeProviderId !== undefined)
                    setActiveProviderId(settings.activeProviderId);
            })
            .catch((caught: unknown) => setError(toSettingsError(caught)));
    }, [desktopPet, providedPreferences]);

    useEffect(() => {
        if (providedProviders !== undefined
            || desktopPet === undefined
            || activeProviderId.length === 0)
            return;
        void desktopPet.getProviderDetails(activeProviderId)
            .then((details) => {
                setForm((current) => applyProviderDetails(current, details));
            })
            .catch((caught: unknown) => setError(toSettingsError(caught)));
    }, [activeProviderId, desktopPet, providedProviders]);

    const selectedProvider = useMemo(
        () => providers.find((provider) => provider.id === activeProviderId),
        [activeProviderId, providers]
    );

    const updateForm = (patch: Partial<ProviderForm>): void => {
        setForm((current) => ({ ...current, ...patch }));
    };

    const saveProvider = async (): Promise<void> => {
        try {
            const config = toProviderSaveConfig(form);
            const save = onSaveProvider ?? desktopPet?.saveProvider;
            const saved = await save?.(config);
            if (saved !== undefined) {
                setProviders((current) => {
                    const next = current.filter((provider) => provider.id !== saved.id);
                    return [...next, saved].sort((left, right) => left.name.localeCompare(right.name));
                });
                setActiveProviderId(saved.id);
                setForm(providerToForm(saved));
            }
            setError(undefined);
        } catch (caught) {
            setError(toSettingsError(caught));
        }
    };

    const deleteProvider = async (): Promise<void> => {
        if (activeProviderId.length === 0)
            return;
        try {
            await (onDeleteProvider ?? desktopPet?.deleteProvider)?.(activeProviderId);
            const next = providers.filter((provider) => provider.id !== activeProviderId);
            setProviders(next);
            const nextActive = next[0]?.id ?? '';
            setActiveProviderId(nextActive);
            setForm(next[0] === undefined ? emptyProviderForm() : providerToForm(next[0]));
            setError(undefined);
        } catch (caught) {
            setError(toSettingsError(caught));
        }
    };

    const testProvider = async (capability: 'text' | 'vision'): Promise<void> => {
        if (activeProviderId.length === 0)
            return;
        try {
            const result = await (onTestProvider ?? desktopPet?.testProvider)?.(
                activeProviderId,
                capability
            );
            if (result !== undefined)
                setTestResult(result);
            setError(undefined);
        } catch (caught) {
            setError(toSettingsError(caught));
        }
    };

    const savePreferences = async (): Promise<void> => {
        const validation = validateHotkey(hotkeyDraft);
        if (!validation.valid) {
            setError({ code: 'invalid-request', message: validation.error ?? 'Hotkey is invalid.' });
            return;
        }
        const next = {
            ...preferences,
            hotkey: validation.value ?? hotkeyDraft
        };
        try {
            const parsed = settingsPreferencesSchema.parse(next);
            await (onSavePreferences ?? desktopPet?.saveSettings)?.(parsed);
            setPreferences(parsed);
            setError(undefined);
        } catch (caught) {
            setError(toSettingsError(caught));
        }
    };

    return (
        <main aria-label="Translator settings">
            <h1>Settings</h1>
            {error === undefined ? null : (
                <p role="alert" data-error-code={error.code}>{error.message}</p>
            )}
            <section aria-label="Provider settings">
                <h2>Providers</h2>
                <label>
                    Active provider
                    <select
                        aria-label="Active provider"
                        value={activeProviderId}
                        onChange={(event) => {
                            const providerId = event.target.value;
                            setActiveProviderId(providerId);
                            const provider = providers.find((item) => item.id === providerId);
                            setForm(provider === undefined ? emptyProviderForm() : providerToForm(provider));
                            void (onSelectProvider ?? desktopPet?.setActiveProvider)?.(providerId);
                        }}
                    >
                        <option value="">Select provider</option>
                        {providers.map((provider) => (
                            <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                    </select>
                </label>
                <div>
                    <button type="button" onClick={() => {
                        setActiveProviderId('');
                        setForm(emptyProviderForm());
                    }}>Add provider</button>
                    <button type="button" onClick={() => void deleteProvider()}>Delete provider</button>
                    <button type="button" onClick={() => void testProvider('text')}>Test text connection</button>
                    <button type="button" onClick={() => void testProvider('vision')}>Test vision connection</button>
                </div>
                <label>
                    Name
                    <input value={form.name} onChange={(event) => updateForm({ name: event.target.value })} />
                </label>
                <label>
                    HTTPS Base URL
                    <input value={form.baseUrl} onChange={(event) => updateForm({ baseUrl: event.target.value })} />
                </label>
                <label>
                    API key
                    <input
                        type="password"
                        aria-label="API key write-only replacement"
                        placeholder="Write-only replacement"
                        value={form.apiKey}
                        onChange={(event) => updateForm({ apiKey: event.target.value })}
                    />
                    <small>{selectedProvider?.hasApiKey === true ? maskSecret('stored') : maskSecret('')}</small>
                </label>
                <label>
                    Text model
                    <input value={form.textModel} onChange={(event) => updateForm({ textModel: event.target.value })} />
                </label>
                <label>
                    Vision model
                    <input value={form.visionModel} onChange={(event) => updateForm({ visionModel: event.target.value })} />
                </label>
                <label>
                    System prompt
                    <textarea value={form.systemPrompt} onChange={(event) => updateForm({ systemPrompt: event.target.value })} />
                </label>
                <label>
                    Target language
                    <input value={form.targetLanguage} onChange={(event) => updateForm({ targetLanguage: event.target.value })} />
                </label>
                <label>
                    Timeout (ms)
                    <input type="number" value={form.timeoutMs} onChange={(event) => updateForm({ timeoutMs: event.target.value })} />
                </label>
                <label>
                    <input type="checkbox" checked={form.streaming} onChange={(event) => updateForm({ streaming: event.target.checked })} />
                    Streaming
                </label>
                <button type="button" onClick={() => void saveProvider()}>Save provider</button>
                {testResult === undefined ? null : (
                    <p role="status" data-test-capability={testResult.capability}>{testResult.message}</p>
                )}
            </section>
            <section aria-label="Shortcut settings">
                <h2>Shortcut</h2>
                <label>
                    Translation hotkey
                    <input
                        aria-label="Translation hotkey"
                        value={hotkeyDraft}
                        onChange={(event) => setHotkeyDraft(event.target.value)}
                        onKeyDown={(event) => {
                            event.preventDefault();
                            setHotkeyDraft(hotkeyFromEvent(event));
                        }}
                    />
                </label>
            </section>
            <section aria-label="Privacy">
                <h2>Privacy</h2>
                <label><input type="checkbox" checked={preferences.privacy.localOnly} onChange={(event) => setPreferences({
                    ...preferences,
                    privacy: { ...preferences.privacy, localOnly: event.target.checked }
                })} /> Local-only processing</label>
                <label><input type="checkbox" checked={preferences.privacy.saveTranslationHistory} onChange={(event) => setPreferences({
                    ...preferences,
                    privacy: { ...preferences.privacy, saveTranslationHistory: event.target.checked }
                })} /> Save translation history</label>
                <label><input type="checkbox" checked={preferences.privacy.restoreClipboard} onChange={(event) => setPreferences({
                    ...preferences,
                    privacy: { ...preferences.privacy, restoreClipboard: event.target.checked }
                })} /> Restore clipboard</label>
            </section>
            <section aria-label="Performance">
                <h2>Performance</h2>
                <label><input type="checkbox" checked={preferences.performance.reduceMotion} onChange={(event) => setPreferences({
                    ...preferences,
                    performance: { ...preferences.performance, reduceMotion: event.target.checked }
                })} /> Reduce motion</label>
                <label><input type="checkbox" checked={preferences.performance.pauseWhenFullscreen} onChange={(event) => setPreferences({
                    ...preferences,
                    performance: { ...preferences.performance, pauseWhenFullscreen: event.target.checked }
                })} /> Pause when fullscreen</label>
                <label><input type="checkbox" checked={preferences.performance.limitFrameRate} onChange={(event) => setPreferences({
                    ...preferences,
                    performance: { ...preferences.performance, limitFrameRate: event.target.checked }
                })} /> Limit frame rate</label>
                <button type="button" onClick={() => void savePreferences()}>Save preferences</button>
            </section>
        </main>
    );
}

function toSettingsError(error: unknown): SettingsError {
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        return {
            code: typeof code === 'string' ? code : 'request-failed',
            message: error.message
        };
    }
    return {
        code: 'request-failed',
        message: 'Settings request failed.'
    };
}
