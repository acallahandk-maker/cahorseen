import { useEffect, useRef, useState } from 'react';
import {
    isValidHotkey,
    settingsPreferencesSchema,
    type ConnectionTestResult,
    type ProviderDetails,
    type ProviderSaveConfig,
    type ProviderSummary,
    type SettingsPreferences,
    type VocabularyRepositoryFacade
} from '../../shared/contracts';
import {
    VocabularyHeatView,
    type VocabularyHeatViewProps
} from '../learning/VocabularyHeatView';

export interface SettingsError {
    code: string;
    message: string;
}

export interface SettingsStateSnapshot {
    providers: ProviderSummary[];
    activeProviderId?: string;
    preferences: SettingsPreferences;
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
    onLoadProviderDetails?: (providerId: string) => Promise<ProviderDetails>;
    onReloadState?: () => Promise<SettingsStateSnapshot>;
    vocabulary?: VocabularyHeatViewProps;
    vocabularyRepository?: VocabularyRepositoryFacade;
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

function getDesktopPetApi(): SettingsDesktopPetApi | undefined {
    return typeof window === 'undefined'
        ? undefined
        : (window as unknown as { desktopPet?: SettingsDesktopPetApi }).desktopPet;
}

export function maskSecret(secret: string): string {
    return secret.length === 0 ? 'Not set' : '••••••••';
}

function normalizeKey(value: string): string {
    return value.length === 1 ? value.toUpperCase() : value;
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
    return isValidHotkey(hotkey)
        ? { valid: true, value: hotkey.split('+').map((part) => part.trim()).join('+') }
        : {
            valid: false,
            error: 'Use one or more modifiers plus exactly one non-modifier key.'
        };
}

interface ProviderForm {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    textModel: string;
    visionModel: string;
    systemPrompt?: string;
    targetLanguage?: string;
    timeoutMs?: string;
    streaming?: boolean;
}

function emptyProviderForm(): ProviderForm {
    return {
        name: '',
        baseUrl: '',
        apiKey: '',
        textModel: '',
        visionModel: '',
        systemPrompt: undefined,
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
        apiKey: '',
        textModel: details.textModel,
        visionModel: details.visionModel,
        systemPrompt: details.systemPrompt,
        targetLanguage: details.targetLanguage,
        timeoutMs: details.timeoutMs === undefined ? undefined : String(details.timeoutMs),
        streaming: details.streaming
    };
}

function toProviderSaveConfig(form: ProviderForm): ProviderSaveConfig {
    const timeoutValue = form.timeoutMs?.trim();
    const timeoutMs = timeoutValue === undefined || timeoutValue.length === 0
        ? undefined
        : Number(timeoutValue);
    return {
        ...(form.id === undefined ? {} : { id: form.id }),
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.length === 0 ? {} : { apiKey: form.apiKey }),
        textModel: form.textModel.trim(),
        visionModel: form.visionModel.trim(),
        ...(form.systemPrompt === undefined
            ? {}
            : { systemPrompt: form.systemPrompt.trim() }),
        ...(form.targetLanguage === undefined || form.targetLanguage.trim().length === 0
            ? {}
            : { targetLanguage: form.targetLanguage.trim() }),
        ...(timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs > 0
            ? { timeoutMs }
            : {}),
        ...(form.streaming === undefined ? {} : { streaming: form.streaming })
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
    onSavePreferences,
    onLoadProviderDetails,
    onReloadState,
    vocabulary,
    vocabularyRepository
}: SettingsWindowProps): React.JSX.Element {
    const desktopPet = getDesktopPetApi();
    const [providers, setProviders] = useState<ProviderSummary[]>(providedProviders ?? []);
    const [activeProviderId, setActiveProviderId] = useState(
        providedActiveProviderId ?? ''
    );
    const [preferences, setPreferences] = useState<SettingsPreferences>(
        providedPreferences ?? defaultPreferences
    );
    const [form, setForm] = useState<ProviderForm>();
    const [loadedProviderId, setLoadedProviderId] = useState('');
    const [loading, setLoading] = useState(
        providedProviders === undefined || providedPreferences === undefined
    );
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [selectionPending, setSelectionPending] = useState(false);
    const [error, setError] = useState<SettingsError | undefined>(providedError);
    const [testResult, setTestResult] = useState<ConnectionTestResult>();
    const [hotkeyDraft, setHotkeyDraft] = useState(preferences.hotkey);
    const detailGeneration = useRef(0);
    const selectionGeneration = useRef(0);
    const initialDetailsRequested = useRef(false);
    const mutationQueue = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        if (providedProviders !== undefined)
            setProviders(providedProviders);
    }, [providedProviders]);

    useEffect(() => {
        if (providedPreferences !== undefined) {
            setPreferences(providedPreferences);
            setHotkeyDraft(providedPreferences.hotkey);
        }
    }, [providedPreferences]);

    useEffect(() => {
        if (providedError !== undefined)
            setError(providedError);
    }, [providedError]);

    const loadProviderDetails = async (
        providerId: string,
        generation: number
    ): Promise<void> => {
        if (detailGeneration.current !== generation)
            return;
        const loader = onLoadProviderDetails ?? desktopPet?.getProviderDetails;
        if (loader === undefined)
            throw new Error('Provider details are unavailable.');
        setDetailsLoading(true);
        try {
            const details = await loader(providerId);
            if (detailGeneration.current !== generation || details.id !== providerId)
                return;
            setForm((current) => applyProviderDetails(current ?? emptyProviderForm(), details));
            setLoadedProviderId(providerId);
        } finally {
            if (detailGeneration.current === generation)
                setDetailsLoading(false);
        }
    };

    const readStateSnapshot = async (): Promise<SettingsStateSnapshot> => {
        if (onReloadState !== undefined)
            return onReloadState();
        if (desktopPet !== undefined) {
            const [nextProviders, settings] = await Promise.all([
                desktopPet.getProviderSummaries(),
                desktopPet.getSettings()
            ]);
            return {
                providers: nextProviders,
                activeProviderId: settings.activeProviderId,
                preferences: settings.preferences
            };
        }
        return { providers, activeProviderId, preferences };
    };

    const applyStateSnapshot = async (
        snapshot: SettingsStateSnapshot,
        generation: number
    ): Promise<void> => {
        if (selectionGeneration.current !== generation)
            return;
        const nextActive = snapshot.activeProviderId ?? snapshot.providers[0]?.id ?? '';
        setProviders(snapshot.providers);
        setActiveProviderId(nextActive);
        setPreferences(snapshot.preferences);
        setHotkeyDraft(snapshot.preferences.hotkey);
        setLoading(false);
        if (nextActive.length === 0) {
            ++detailGeneration.current;
            setForm(undefined);
            setLoadedProviderId('');
            setDetailsLoading(false);
            return;
        }
        const detailsGeneration = ++detailGeneration.current;
        await loadProviderDetails(nextActive, detailsGeneration);
    };

    const enqueueProviderMutation = async <T,>(
        operation: () => Promise<T>
    ): Promise<T> => {
        const queued = mutationQueue.current.then(operation, operation);
        mutationQueue.current = queued.then(() => undefined, () => undefined);
        return queued;
    };

    useEffect(() => {
        if (providedProviders !== undefined
            || providedPreferences !== undefined
            || desktopPet === undefined)
            return;
        const generation = ++selectionGeneration.current;
        void Promise.all([
            desktopPet.getProviderSummaries(),
            desktopPet.getSettings()
        ]).then(([summaries, settings]) => {
            if (selectionGeneration.current !== generation)
                return;
            const nextActive = settings.activeProviderId ?? summaries[0]?.id ?? '';
            setProviders(summaries);
            setPreferences(settings.preferences);
            setHotkeyDraft(settings.preferences.hotkey);
            setActiveProviderId(nextActive);
            setLoading(false);
            if (nextActive.length > 0) {
                const detailsGeneration = ++detailGeneration.current;
                void loadProviderDetails(nextActive, detailsGeneration).catch((caught: unknown) => {
                    if (detailGeneration.current === detailsGeneration)
                        setError(toSettingsError(caught));
                });
            }
        }).catch((caught: unknown) => {
            if (selectionGeneration.current === generation) {
                setLoading(false);
                setError(toSettingsError(caught));
            }
        });
    }, [desktopPet, providedPreferences, providedProviders]);

    useEffect(() => {
        if (initialDetailsRequested.current
            || loading
            || activeProviderId.length === 0
            || providedProviders === undefined)
            return;
        initialDetailsRequested.current = true;
        const generation = ++detailGeneration.current;
        void loadProviderDetails(activeProviderId, generation).catch((caught: unknown) => {
            if (detailGeneration.current === generation)
                setError(toSettingsError(caught));
        });
    }, [activeProviderId, loading, providedProviders]);

    const providerActionsDisabled = loading
        || selectionPending
        || detailsLoading
        || form === undefined
        || loadedProviderId !== (form.id ?? 'new-provider');
    const deleteDisabled = providerActionsDisabled || form?.id === undefined;

    const updateForm = (patch: Partial<ProviderForm>): void => {
        ++detailGeneration.current;
        setDetailsLoading(false);
        setForm((current) => ({ ...(current ?? emptyProviderForm()), ...patch }));
    };

    const startProviderCreation = (): void => {
        ++detailGeneration.current;
        ++selectionGeneration.current;
        setActiveProviderId('');
        setLoadedProviderId('new-provider');
        setForm(emptyProviderForm());
        setDetailsLoading(false);
        setSelectionPending(false);
        setError(undefined);
    };

    const selectProvider = async (providerId: string): Promise<void> => {
        const selectionId = ++selectionGeneration.current;
        const detailsGeneration = ++detailGeneration.current;
        setActiveProviderId(providerId);
        setLoadedProviderId('');
        setForm(undefined);
        setSelectionPending(true);
        setError(undefined);
        await enqueueProviderMutation(async () => {
            let previousStoredId = activeProviderId;
            try {
                const before = await readStateSnapshot();
                previousStoredId = before.activeProviderId ?? previousStoredId;
                await (onSelectProvider ?? desktopPet?.setActiveProvider)?.(providerId);
                await loadProviderDetails(providerId, detailsGeneration);
            } catch (caught) {
                let rollbackError: unknown;
                try {
                    if (previousStoredId.length > 0)
                        await (onSelectProvider ?? desktopPet?.setActiveProvider)?.(
                            previousStoredId
                        );
                } catch (rollbackFailure) {
                    rollbackError = rollbackFailure;
                }
                let reloadError: unknown;
                try {
                    await applyStateSnapshot(await readStateSnapshot(), selectionId);
                } catch (reloadFailure) {
                    reloadError = reloadFailure;
                }
                if (selectionGeneration.current === selectionId) {
                    setError(toSettingsError(
                        rollbackError ?? reloadError ?? caught
                    ));
                }
            } finally {
                if (selectionGeneration.current === selectionId)
                    setSelectionPending(false);
            }
        });
    };

    const saveProvider = async (): Promise<void> => {
        if (form === undefined || providerActionsDisabled)
            return;
        const formSnapshot = form;
        const generation = ++selectionGeneration.current;
        ++detailGeneration.current;
        setDetailsLoading(false);
        await enqueueProviderMutation(async () => {
            try {
                const config = toProviderSaveConfig(formSnapshot);
                const saved = await (onSaveProvider ?? desktopPet?.saveProvider)?.(config);
                if (selectionGeneration.current !== generation)
                    return;
                const resolvedId = saved?.id ?? formSnapshot.id ?? 'new-provider';
                setProviders((current) => saved === undefined
                    ? current
                    : [...current.filter((provider) => provider.id !== saved.id), saved]
                        .sort((left, right) => left.name.localeCompare(right.name)));
                setForm({ ...formSnapshot, id: resolvedId, apiKey: '' });
                setLoadedProviderId(resolvedId);
                if (activeProviderId.length === 0)
                    setActiveProviderId(resolvedId);
                setError(undefined);
            } catch (caught) {
                if (selectionGeneration.current === generation)
                    setError(toSettingsError(caught));
            }
        });
    };

    const deleteProvider = async (): Promise<void> => {
        if (deleteDisabled)
            return;
        const providerId = form?.id ?? activeProviderId;
        const generation = ++selectionGeneration.current;
        ++detailGeneration.current;
        setDetailsLoading(false);
        await enqueueProviderMutation(async () => {
            try {
                await (onDeleteProvider ?? desktopPet?.deleteProvider)?.(providerId);
                if (selectionGeneration.current !== generation)
                    return;
                const authoritative = onReloadState !== undefined || desktopPet !== undefined;
                const snapshot = authoritative
                    ? await readStateSnapshot()
                    : (() => {
                        const nextProviders = providers.filter(
                            (provider) => provider.id !== providerId
                        );
                        return {
                            providers: nextProviders,
                            activeProviderId: activeProviderId === providerId
                                ? nextProviders[0]?.id
                                : activeProviderId,
                            preferences
                        };
                    })();
                await applyStateSnapshot(snapshot, generation);
                setError(undefined);
            } catch (caught) {
                if (selectionGeneration.current === generation)
                    setError(toSettingsError(caught));
            }
        });
    };

    const testProvider = async (capability: 'text' | 'vision'): Promise<void> => {
        if (providerActionsDisabled)
            return;
        try {
            const result = await (onTestProvider ?? desktopPet?.testProvider)?.(
                form?.id ?? activeProviderId,
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
            setError({
                code: 'invalid-request',
                message: validation.error ?? 'Hotkey is invalid.'
            });
            return;
        }
        try {
            const parsed = settingsPreferencesSchema.parse({
                ...preferences,
                hotkey: validation.value ?? hotkeyDraft
            });
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
                        disabled={loading || selectionPending}
                        onChange={(event) => void selectProvider(event.target.value)}
                    >
                        <option value="">Select provider</option>
                        {providers.map((provider) => (
                            <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                    </select>
                </label>
                <div>
                    <button type="button" disabled={loading} onClick={startProviderCreation}>
                        Add provider
                    </button>
                    <button type="button" disabled={deleteDisabled} onClick={() => void deleteProvider()}>
                        Delete provider
                    </button>
                    <button type="button" disabled={providerActionsDisabled} onClick={() => void testProvider('text')}>
                        Test text connection
                    </button>
                    <button type="button" disabled={providerActionsDisabled} onClick={() => void testProvider('vision')}>
                        Test vision connection
                    </button>
                </div>
                <label>
                    Name
                    <input
                        value={form?.name ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ name: event.target.value })}
                    />
                </label>
                <label>
                    HTTPS Base URL
                    <input
                        value={form?.baseUrl ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ baseUrl: event.target.value })}
                    />
                </label>
                <label>
                    API key
                    <input
                        type="password"
                        aria-label="API key"
                        placeholder="Write-only replacement"
                        value={form?.apiKey ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ apiKey: event.target.value })}
                    />
                    <small>{activeProviderId.length === 0 ? maskSecret('') : maskSecret('stored')}</small>
                </label>
                <label>
                    Text model
                    <input
                        value={form?.textModel ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ textModel: event.target.value })}
                    />
                </label>
                <label>
                    Vision model
                    <input
                        value={form?.visionModel ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ visionModel: event.target.value })}
                    />
                </label>
                <label>
                    System prompt
                    <textarea
                        value={form?.systemPrompt ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ systemPrompt: event.target.value })}
                    />
                </label>
                <label>
                    Target language
                    <input
                        value={form?.targetLanguage ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ targetLanguage: event.target.value })}
                    />
                </label>
                <label>
                    Timeout (ms)
                    <input
                        type="number"
                        value={form?.timeoutMs ?? ''}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ timeoutMs: event.target.value })}
                    />
                </label>
                <label>
                    <input
                        type="checkbox"
                        checked={form?.streaming ?? false}
                        disabled={form === undefined}
                        onChange={(event) => updateForm({ streaming: event.target.checked })}
                    />
                    Streaming
                </label>
                <button
                    type="button"
                    disabled={form === undefined || providerActionsDisabled}
                    onClick={() => void saveProvider()}
                >
                    Save provider
                </button>
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
                            const captured = hotkeyFromEvent(event);
                            const validation = validateHotkey(captured);
                            setHotkeyDraft(captured);
                            if (!validation.valid) {
                                setError({
                                    code: 'invalid-request',
                                    message: validation.error ?? 'Hotkey is invalid.'
                                });
                            }
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
                <button type="button" disabled={loading} onClick={() => void savePreferences()}>
                    Save preferences
                </button>
            </section>
            {vocabulary === undefined && vocabularyRepository === undefined ? null : (
                <section aria-label="Vocabulary history and heat">
                    <h2>Vocabulary history &amp; heat</h2>
                    <VocabularyHeatView
                        statistics={vocabulary?.statistics ?? []}
                        entries={vocabulary?.entries ?? []}
                        now={vocabulary?.now}
                        actions={vocabulary?.actions}
                        virtualization={vocabulary?.virtualization}
                        repository={vocabularyRepository ?? vocabulary?.repository}
                        memoryPaused={vocabulary?.memoryPaused}
                        privacyLocalOnly={preferences.privacy.localOnly}
                    />
                </section>
            )}
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
