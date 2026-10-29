// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    IpcClientError,
    parseIpcResult
} from '../../src/preload/ipcResult';
import SettingsWindow, {
    maskSecret,
    validateHotkey
} from '../../src/renderer/settings/SettingsWindow';
import {
    settingsPreferencesSchema,
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

afterEach(cleanup);

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

        await user.type(screen.getByLabelText('API key'), 'sk-synthetic-replacement-123');
        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        expect(onSaveProvider).toHaveBeenLastCalledWith(expect.objectContaining({
            apiKey: 'sk-synthetic-replacement-123'
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
        await user.type(screen.getByLabelText('API key'), 'sk-synthetic-created-123');
        await user.type(screen.getByLabelText('Text model'), 'created-text');
        await user.type(screen.getByLabelText('Vision model'), 'created-vision');
        await user.click(screen.getByRole('button', { name: 'Save provider' }));
        expect(onSaveProvider).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Created Provider',
            apiKey: 'sk-synthetic-created-123',
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

    it('preserves typed codes when parsing IPC failures and masks stored secrets', () => {
        expect(maskSecret('sk-synthetic-test-only-123')).toBe('••••••••');
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
});
