// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    IpcClientError,
    parseIpcResult,
    parseIpcTaskResult
} from '../../src/preload/ipcResult';
import SettingsWindow, {
    maskSecret,
    validateHotkey
} from '../../src/renderer/settings/SettingsWindow';
import {
    settingsPreferencesSchema,
    translationTaskSchema,
    type ProviderDetails,
    type ProviderSummary,
    type SettingsPreferences
} from '../../src/shared/contracts';

const providers: ProviderSummary[] = [
    {
        id: 'provider-a',
        name: 'Provider A',
        baseUrl: 'https://provider-a.example/v1',
        hasApiKey: true,
        textModel: 'text-a',
        visionModel: 'vision-a'
    },
    {
        id: 'provider-b',
        name: 'Provider B',
        baseUrl: 'https://provider-b.example/v1',
        hasApiKey: true,
        textModel: 'text-b',
        visionModel: 'vision-b'
    }
];

const detailsA: ProviderDetails = {
    id: 'provider-a',
    name: 'Provider A',
    baseUrl: 'https://provider-a.example/v1',
    textModel: 'text-a',
    visionModel: 'vision-a',
    systemPrompt: 'Stored prompt A',
    targetLanguage: 'ja',
    timeoutMs: 12_345,
    streaming: false
};

const detailsB: ProviderDetails = {
    id: 'provider-b',
    name: 'Provider B',
    baseUrl: 'https://provider-b.example/v1',
    textModel: 'text-b',
    visionModel: 'vision-b',
    systemPrompt: 'Stored prompt B',
    targetLanguage: 'fr',
    timeoutMs: 23_456,
    streaming: true
};

const preferences: SettingsPreferences = {
    hotkey: 'Ctrl+Shift+T',
    screenshotHotkey: 'Ctrl+Shift+S',
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
};

afterEach(() => {
    cleanup();
    delete (window as unknown as { desktopPet?: unknown }).desktopPet;
});

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('SettingsWindow', () => {
    it('loads provider details before enabling save and destructive actions', async () => {
        const onLoadProviderDetails = vi.fn(async () => detailsA);
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={onLoadProviderDetails}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', {
            name: 'Delete provider'
        }) as HTMLButtonElement).disabled).toBe(true);
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt A'
        );
        expect(screen.getByLabelText('Target language')).toHaveProperty('value', 'ja');
        expect(screen.getByLabelText('Timeout (ms)')).toHaveProperty('value', '12345');
        expect(screen.getByLabelText('Streaming')).toHaveProperty('checked', false);
    });

    it('updates providers write-only and replaces a key only after explicit entry', async () => {
        const user = userEvent.setup();
        const onSaveProvider = vi.fn(async () => ({ ...providers[0] }));
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async () => detailsA)}
                onSaveProvider={onSaveProvider}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        expect(onSaveProvider).toHaveBeenLastCalledWith(expect.not.objectContaining({
            apiKey: expect.anything()
        }));

        await user.type(screen.getByLabelText('API key'), 'placeholder-safe-credential');
        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        expect(onSaveProvider).toHaveBeenLastCalledWith(expect.objectContaining({
            apiKey: 'placeholder-safe-credential'
        }));
    });

    it('preserves stored optional provider values and omits defaults on save', async () => {
        const user = userEvent.setup();
        const onSaveProvider = vi.fn(async () => ({ ...providers[0] }));
        const optionalDetails: ProviderDetails = {
            ...detailsA,
            systemPrompt: '',
            targetLanguage: undefined,
            timeoutMs: undefined,
            streaming: undefined
        };
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async () => optionalDetails)}
                onSaveProvider={onSaveProvider}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.click(screen.getByRole('button', { name: 'Save provider' }));

        expect(onSaveProvider).toHaveBeenCalledWith({
            id: 'provider-a',
            name: 'Provider A',
            baseUrl: 'https://provider-a.example/v1',
            textModel: 'text-a',
            visionModel: 'vision-a',
            systemPrompt: ''
        });
    });

    it('creates and deletes providers through user interactions', async () => {
        const user = userEvent.setup();
        const onSaveProvider = vi.fn(async () => ({
            id: 'created-provider',
            name: 'Created Provider',
            baseUrl: 'https://created.example/v1',
            hasApiKey: true,
            textModel: 'created-text',
            visionModel: 'created-vision'
        }));
        const onDeleteProvider = vi.fn(async () => undefined);
        render(
            <SettingsWindow
                providers={[]}
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async () => detailsA)}
                onSaveProvider={onSaveProvider}
                onDeleteProvider={onDeleteProvider}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Add provider' }));
        await user.type(screen.getByLabelText('Name'), 'Created Provider');
        await user.type(screen.getByLabelText('HTTPS Base URL'), 'https://created.example/v1');
        await user.type(screen.getByLabelText('API key'), 'placeholder-safe-credential');
        await user.type(screen.getByLabelText('Text model'), 'created-text');
        await user.type(screen.getByLabelText('Vision model'), 'created-vision');
        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        expect(onSaveProvider).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Created Provider',
            apiKey: 'placeholder-safe-credential',
            textModel: 'created-text',
            visionModel: 'created-vision'
        }));

        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Delete provider'
        }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole('button', { name: 'Delete provider' }));
        expect(onDeleteProvider).toHaveBeenCalledWith('created-provider');
    });

    it('rolls back provider selection and renders the typed failure code', async () => {
        const user = userEvent.setup();
        const onSelectProvider = vi.fn(async () => {
            throw new IpcClientError('storage-error', 'Provider storage could not be updated.');
        });
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async (providerId) => (
                    providerId === 'provider-a' ? detailsA : detailsB
                ))}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={onSelectProvider}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        await waitFor(() => expect(screen.getByRole('alert').getAttribute(
            'data-error-code'
        )).toBe('storage-error'));
        expect(screen.getByLabelText('Active provider')).toHaveProperty('value', 'provider-a');
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt A'
        );
    });

    it('ignores stale provider detail responses during rapid selection', async () => {
        const user = userEvent.setup();
        let resolveA: ((details: ProviderDetails) => void) | undefined;
        let resolveB: ((details: ProviderDetails) => void) | undefined;
        const onLoadProviderDetails = vi.fn((providerId: string) => new Promise<ProviderDetails>(
            (resolve) => {
                if (providerId === 'provider-a')
                    resolveA = resolve;
                else
                    resolveB = resolve;
            }
        ));
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={onLoadProviderDetails}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn(async () => undefined)}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        resolveB?.(detailsB);
        await waitFor(() => expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt B'
        ));
        resolveA?.(detailsA);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt B'
        );
        expect(screen.getByLabelText('Target language')).toHaveProperty('value', 'fr');
    });

    it('ignores stale provider detail failures during rapid selection', async () => {
        const user = userEvent.setup();
        let rejectA: ((error: unknown) => void) | undefined;
        let resolveB: ((details: ProviderDetails) => void) | undefined;
        const onLoadProviderDetails = vi.fn((providerId: string) => new Promise<ProviderDetails>(
            (resolve, reject) => {
                if (providerId === 'provider-a')
                    rejectA = reject;
                else
                    resolveB = resolve;
            }
        ));
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={onLoadProviderDetails}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn(async () => undefined)}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        resolveB?.(detailsB);
        await waitFor(() => expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt B'
        ));
        rejectA?.(new IpcClientError('timeout', 'Stale provider request timed out.'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt B'
        );
    });

    it('serializes concurrent save delete and select mutations', async () => {
        const user = userEvent.setup();
        const save = deferred<ProviderSummary>();
        const remove = deferred<void>();
        const select = deferred<void>();
        const onSaveProvider = vi.fn(() => save.promise);
        const onDeleteProvider = vi.fn(() => remove.promise);
        const onSelectProvider = vi.fn(() => select.promise);
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async (providerId) => (
                    providerId === 'provider-a' ? detailsA : detailsB
                ))}
                onSaveProvider={onSaveProvider}
                onDeleteProvider={onDeleteProvider}
                onSelectProvider={onSelectProvider}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        await user.click(screen.getByRole('button', { name: 'Delete provider' }));
        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');

        expect(onSaveProvider).toHaveBeenCalledTimes(1);
        expect(onDeleteProvider).not.toHaveBeenCalled();
        expect(onSelectProvider).not.toHaveBeenCalled();
        save.resolve(providers[0]);
        await waitFor(() => expect(onDeleteProvider).toHaveBeenCalledTimes(1));
        expect(onSelectProvider).not.toHaveBeenCalled();
        remove.resolve();
        await waitFor(() => expect(onSelectProvider).toHaveBeenCalledTimes(1));
        select.resolve();
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('cleans current detail loading across stale success and failure responses', async () => {
        const user = userEvent.setup();
        const staleSuccess = deferred<ProviderDetails>();
        const currentDetails = deferred<ProviderDetails>();
        const onLoadProviderDetails = vi.fn((providerId: string) => (
            providerId === 'provider-a' ? staleSuccess.promise : currentDetails.promise
        ));
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={onLoadProviderDetails}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn(async () => undefined)}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        staleSuccess.resolve(detailsA);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(true);
        currentDetails.resolve(detailsB);
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        cleanup();
        const staleFailure = deferred<ProviderDetails>();
        const nextDetails = deferred<ProviderDetails>();
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn((providerId: string) => (
                    providerId === 'provider-a' ? staleFailure.promise : nextDetails.promise
                ))}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn(async () => undefined)}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );
        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        staleFailure.reject(new IpcClientError('timeout', 'Stale timeout.'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(true);
        nextDetails.resolve(detailsB);
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('rolls back to the stored active provider and reloads authoritative state', async () => {
        const user = userEvent.setup();
        const setActiveProvider = vi.fn(async (providerId: string) => {
            if (providerId === 'provider-b')
                throw new IpcClientError('provider-not-found', 'Provider is not configured.');
        });
        const getSettings = vi.fn(async () => ({
            activeProviderId: 'provider-a',
            preferences
        }));
        const getProviderSummaries = vi.fn(async () => providers);
        (window as unknown as { desktopPet?: unknown }).desktopPet = {
            getProviderSummaries,
            getProviderDetails: vi.fn(async (providerId: string) => (
                providerId === 'provider-a' ? detailsA : detailsB
            )),
            getSettings,
            saveProvider: vi.fn(),
            deleteProvider: vi.fn(),
            setActiveProvider,
            testProvider: vi.fn(),
            saveSettings: vi.fn()
        };
        render(<SettingsWindow />);
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        await waitFor(() => expect(setActiveProvider).toHaveBeenNthCalledWith(2, 'provider-a'));
        await waitFor(() => expect(getSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(getProviderSummaries.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByLabelText('Active provider')).toHaveProperty('value', 'provider-a');
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt A'
        );
    });

    it('reloads authoritative state and surfaces typed rollback failure', async () => {
        const user = userEvent.setup();
        const setActiveProvider = vi.fn(async (providerId: string) => {
            if (providerId === 'provider-b')
                throw new IpcClientError('provider-not-found', 'Provider is not configured.');
            throw new IpcClientError('storage-error', 'Provider storage could not be updated.');
        });
        let settingsReads = 0;
        const getSettings = vi.fn(async () => ({
            activeProviderId: ++settingsReads <= 2 ? 'provider-a' : 'provider-b',
            preferences
        }));
        const getProviderSummaries = vi.fn(async () => providers);
        (window as unknown as { desktopPet?: unknown }).desktopPet = {
            getProviderSummaries,
            getProviderDetails: vi.fn(async (providerId: string) => (
                providerId === 'provider-a' ? detailsA : detailsB
            )),
            getSettings,
            saveProvider: vi.fn(),
            deleteProvider: vi.fn(),
            setActiveProvider,
            testProvider: vi.fn(),
            saveSettings: vi.fn()
        };
        render(<SettingsWindow />);
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Save provider'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.selectOptions(screen.getByLabelText('Active provider'), 'provider-b');
        expect(setActiveProvider.mock.calls).toEqual([
            ['provider-b'],
            ['provider-a']
        ]);
        await waitFor(() => expect(screen.getByRole('alert').getAttribute(
            'data-error-code'
        )).toBe('storage-error'));
        expect(setActiveProvider).toHaveBeenNthCalledWith(2, 'provider-a');
        expect(getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getProviderSummaries.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByLabelText('Active provider')).toHaveProperty('value', 'provider-b');
        expect(screen.getByLabelText('System prompt')).toHaveProperty(
            'value',
            'Stored prompt B'
        );
    });

    it('tests text and vision connections and saves valid preferences', async () => {
        const user = userEvent.setup();
        const onTestProvider = vi.fn(async (providerId: string, capability: 'text' | 'vision') => ({
            capability,
            success: true as const,
            message: `${providerId} ${capability} passed.`
        }));
        const onSavePreferences = vi.fn(async () => undefined);
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async () => detailsA)}
                onTestProvider={onTestProvider}
                onSavePreferences={onSavePreferences}
            />
        );
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Test text connection'
        }) as HTMLButtonElement).disabled).toBe(false));

        await user.click(screen.getByRole('button', { name: 'Test text connection' }));
        await user.click(screen.getByRole('button', { name: 'Test vision connection' }));
        expect(onTestProvider).toHaveBeenNthCalledWith(1, 'provider-a', 'text');
        expect(onTestProvider).toHaveBeenNthCalledWith(2, 'provider-a', 'vision');

        await user.click(screen.getByRole('button', { name: 'Save preferences' }));
        expect(onSavePreferences).toHaveBeenCalledWith(preferences);
    });

    it('rejects modifier-only hotkey capture at UI and schema layers', async () => {
        const user = userEvent.setup();
        const onSavePreferences = vi.fn(async () => undefined);
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={preferences}
                onLoadProviderDetails={vi.fn(async () => detailsA)}
                onSavePreferences={onSavePreferences}
            />
        );
        const hotkey = screen.getByLabelText('Translation hotkey');
        await user.click(hotkey);
        await user.keyboard('{Control>}{Control}{/Control}');
        await user.click(screen.getByRole('button', { name: 'Save preferences' }));

        expect(onSavePreferences).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').getAttribute('data-error-code')).toBe(
            'invalid-request'
        );
        expect(settingsPreferencesSchema.safeParse({
            ...preferences,
            hotkey: 'Ctrl+Control'
        }).success).toBe(false);
    });

    it('configures both global shortcuts and rejects conflicting keys before saving', async () => {
        const user = userEvent.setup();
        const onSavePreferences = vi.fn(async () => undefined);
        const configurablePreferences = {
            ...preferences,
            screenshotHotkey: 'Ctrl+Shift+S'
        } as SettingsPreferences;
        render(
            <SettingsWindow
                providers={providers}
                activeProviderId="provider-a"
                preferences={configurablePreferences}
                onSavePreferences={onSavePreferences}
            />
        );

        const screenshotHotkey = screen.getByLabelText('Screenshot hotkey');
        expect(screenshotHotkey).toHaveProperty('value', 'Ctrl+Shift+S');
        await user.click(screenshotHotkey);
        await user.keyboard('{Control>}{Shift>}{T}{/Shift}{/Control}');
        await user.click(screen.getByRole('button', { name: 'Save preferences' }));

        expect(onSavePreferences).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toMatch(/unique|conflict/i);
    });

    it('preserves typed codes when parsing IPC failures and masks stored secrets', () => {
        expect(maskSecret('sk-synthetic-test-only')).toBe('••••••••');
        expect(maskSecret('')).toBe('Not set');
        expect(validateHotkey('Ctrl+Shift+T')).toEqual({
            valid: true,
            value: 'Ctrl+Shift+T'
        });
        let thrown: unknown;
        try {
            parseIpcResult(z.string(), {
            ok: false,
            error: {
                code: 'authentication',
                message: 'Provider authentication failed.'
            }
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(IpcClientError);
        expect((thrown as IpcClientError).code).toBe('authentication');
    });

    it('returns complete failed translation tasks while malformed IPC remains typed', () => {
        const failedTask = {
            id: 'failed-task',
            status: 'failed',
            kind: 'selection',
            sourceText: 'exact retry source',
            retryInput: {
                kind: 'selection',
                strategy: 'reuse-source',
                sourceText: 'exact retry source'
            },
            translatedText: '',
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic Provider',
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model',
            translationModel: 'synthetic-text-model',
            error: 'Provider rate limit exceeded.',
            errorCode: 'rate-limited'
        };

        expect(parseIpcTaskResult(translationTaskSchema, {
            ok: false,
            error: {
                code: 'rate-limited',
                message: 'Provider rate limit exceeded.'
            },
            task: failedTask
        })).toEqual(failedTask);
        expect(() => parseIpcTaskResult(translationTaskSchema, {
            ok: false,
            error: {
                code: 'rate-limited',
                message: 'Provider rate limit exceeded.'
            }
        })).toThrow();
    });
});
