import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
    type ConnectionTestResult,
    type ProviderErrorCode,
    type ProviderConfig,
    type ProviderDetails,
    type ProviderSaveConfig,
    type ProviderSummary,
    capturedImageSchema,
    providerDetailsSchema,
    settingsPreferencesSchema,
    type CapturedImage,
    type SettingsPreferences,
    type SettingsState
} from '../../shared/contracts';
import {
    OpenAiClient,
    ProviderError,
    validateProviderConfig
} from './openAiClient';

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

export interface SecureConfigServiceOptions {
    storagePath: string;
    safeStorage: SafeStorageLike;
    fetchImpl?: typeof fetch;
}

export interface TestProviderOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}

export type SecureConfigErrorCode =
    | 'invalid-config'
    | 'invalid-storage'
    | 'provider-not-found'
    | 'storage-unavailable'
    | 'storage-error';

const secureConfigErrorMessages: Record<SecureConfigErrorCode, string> = {
    'invalid-config': 'Provider configuration is invalid.',
    'invalid-storage': 'Provider storage is invalid.',
    'provider-not-found': 'Provider is not configured.',
    'storage-unavailable': 'Secure storage is unavailable.',
    'storage-error': 'Provider storage could not be updated.'
};

export class SecureConfigError extends Error {
    readonly code: SecureConfigErrorCode;

    constructor(code: SecureConfigErrorCode) {
        super(secureConfigErrorMessages[code]);
        this.name = 'SecureConfigError';
        this.code = code;
    }

    toJSON(): { name: string; code: SecureConfigErrorCode; message: string } {
        return {
            name: this.name,
            code: this.code,
            message: this.message
        };
    }
}

export interface ProviderPreset {
    id: string;
    name: string;
    baseUrl: string;
    textModel: string;
    visionModel: string;
    requiresUserBaseUrl: boolean;
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
    hotkey: 'Ctrl+Shift+T',
    screenshotHotkey: 'Ctrl+Shift+S',
    privacy: {
        saveTranslationHistory: false
    },
    performance: {
        reduceMotion: false,
        pauseWhenFullscreen: true
    },
    quiz: {
        paused: false,
        frequencyWeights: {
            occurrenceCount: 1,
            recentOccurrenceCount: 0.25
        }
    }
};

const VISION_PROBE_IMAGE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY1BYte8/AAT+AogiBwaJAAAAAElFTkSuQmCC';

export const VISION_PROBE_IMAGE: CapturedImage = {
    dataUrl: `data:image/png;base64,${VISION_PROBE_IMAGE_BASE64}`,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteLength: 120
};

export function getVisionProbeImage(): CapturedImage {
    const image = capturedImageSchema.parse(VISION_PROBE_IMAGE);
    const bytes = Buffer.from(VISION_PROBE_IMAGE_BASE64, 'base64');
    const validPng = bytes.length === image.byteLength
        && bytes.subarray(0, 8).equals(Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
        ]))
        && bytes.readUInt32BE(8) === 13
        && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
        && bytes.readUInt32BE(16) === 1
        && bytes.readUInt32BE(20) === 1
        && bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') === 'IEND';
    if (!validPng)
        throw new SecureConfigError('invalid-config');
    return image;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
    {
        id: 'mimo',
        name: 'Mimo',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        textModel: '',
        visionModel: '',
        requiresUserBaseUrl: false
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: '',
        textModel: '',
        visionModel: '',
        requiresUserBaseUrl: true
    }
];

const storedProviderSchema = z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    baseUrl: z.string().url().refine((value) => {
        try {
            return new URL(value).protocol === 'https:';
        } catch {
            return false;
        }
    }, {
        message: 'Base URL must use HTTPS'
    }),
    encryptedApiKey: z.string().min(1),
    textModel: z.string().min(1),
    visionModel: z.string().min(1),
    systemPrompt: z.string().optional(),
    targetLanguage: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    streaming: z.boolean().optional()
});

type StoredProvider = z.infer<typeof storedProviderSchema>;
function normalizeStoredPreferences(value: unknown): unknown {
    if (typeof value !== 'object' || value === null)
        return value;
    const record = value as Record<string, unknown>;
    const privacy = typeof record.privacy === 'object' && record.privacy !== null
        ? record.privacy as Record<string, unknown>
        : {};
    const performance = typeof record.performance === 'object' && record.performance !== null
        ? record.performance as Record<string, unknown>
        : {};
    return {
        hotkey: record.hotkey,
        screenshotHotkey: record.screenshotHotkey ?? 'Ctrl+Shift+S',
        privacy: {
            saveTranslationHistory: privacy.saveTranslationHistory ?? false
        },
        performance: {
            reduceMotion: performance.reduceMotion ?? false,
            pauseWhenFullscreen: performance.pauseWhenFullscreen ?? true
        },
        quiz: record.quiz ?? DEFAULT_SETTINGS_PREFERENCES.quiz
    };
}

const storedPreferencesSchema = z.preprocess(
    normalizeStoredPreferences,
    settingsPreferencesSchema
);
const storedStateSchema = z.strictObject({
    version: z.literal(1),
    activeProviderId: z.string().min(1).optional(),
    providers: z.array(storedProviderSchema),
    preferences: storedPreferencesSchema.optional()
});
const persistedStateSchema = z.union([
    storedStateSchema,
    z.array(storedProviderSchema)
]);
type StoredState = z.infer<typeof storedStateSchema>;

export class SecureConfigService {
    private readonly storagePath: string;
    private readonly safeStorage: SafeStorageLike;
    private readonly openAiClient: OpenAiClient;

    constructor(options: SecureConfigServiceOptions) {
        this.storagePath = options.storagePath;
        this.safeStorage = options.safeStorage;
        this.openAiClient = new OpenAiClient({
            fetchImpl: options.fetchImpl
        });
    }

    async saveProvider(config: ProviderSaveConfig): Promise<ProviderSummary> {
        const state = await this.readState();
        const existing = config.id === undefined
            ? undefined
            : state.providers.find((provider) => provider.id === config.id);
        let apiKey: string | undefined;
        if (config.apiKey !== undefined) {
            apiKey = config.apiKey;
        } else if (existing !== undefined) {
            try {
                apiKey = this.safeStorage.decryptString(
                    Buffer.from(existing.encryptedApiKey, 'base64')
                );
            } catch {
                throw new SecureConfigError('storage-error');
            }
        }
        if (apiKey === undefined || apiKey.length === 0)
            throw new SecureConfigError('invalid-config');

        let validated: ProviderConfig;
        try {
            validated = validateProviderConfig({
                ...config,
                apiKey
            });
        } catch {
            throw new SecureConfigError('invalid-config');
        }

        if (!this.safeStorage.isEncryptionAvailable())
            throw new SecureConfigError('storage-unavailable');

        let encryptedApiKey: Buffer;
        try {
            encryptedApiKey = this.safeStorage.encryptString(validated.apiKey);
        } catch {
            throw new SecureConfigError('storage-unavailable');
        }

        if (encryptedApiKey.length === 0)
            throw new SecureConfigError('storage-unavailable');

        const id = validated.id ?? randomUUID();
        const storedProvider: StoredProvider = {
            id,
            name: validated.name,
            baseUrl: validated.baseUrl,
            encryptedApiKey: encryptedApiKey.toString('base64'),
            textModel: validated.textModel,
            visionModel: validated.visionModel,
            systemPrompt: validated.systemPrompt,
            targetLanguage: validated.targetLanguage,
            timeoutMs: validated.timeoutMs,
            streaming: validated.streaming
        };
        const existingIndex = state.providers.findIndex((provider) => provider.id === id);
        if (existingIndex >= 0)
            state.providers[existingIndex] = storedProvider;
        else
            state.providers.push(storedProvider);
        state.activeProviderId ??= id;

        await this.writeState(state);
        return toProviderSummary(storedProvider);
    }

    async deleteProvider(providerId: string): Promise<void> {
        const state = await this.readState();
        const providerIndex = state.providers.findIndex(
            (provider) => provider.id === providerId
        );
        if (providerIndex < 0)
            throw new SecureConfigError('provider-not-found');

        state.providers.splice(providerIndex, 1);
        if (state.activeProviderId === providerId)
            state.activeProviderId = state.providers[0]?.id;
        await this.writeState(state);
    }

    async getProviderSummaries(): Promise<ProviderSummary[]> {
        return (await this.readState()).providers.map(toProviderSummary);
    }

    async getProviderDetails(providerId: string): Promise<ProviderDetails> {
        const state = await this.readState();
        const provider = state.providers.find((item) => item.id === providerId);
        if (provider === undefined)
            throw new SecureConfigError('provider-not-found');
        return providerDetailsSchema.parse({
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            textModel: provider.textModel,
            visionModel: provider.visionModel,
            systemPrompt: provider.systemPrompt,
            targetLanguage: provider.targetLanguage,
            timeoutMs: provider.timeoutMs,
            streaming: provider.streaming
        });
    }

    async getActiveProviderConfig(): Promise<ProviderConfig> {
        const state = await this.readState();
        if (state.activeProviderId === undefined)
            throw new SecureConfigError('provider-not-found');
        return this.getProviderForTest(state.activeProviderId);
    }

    async setActiveProvider(providerId: string): Promise<void> {
        const state = await this.readState();
        if (!state.providers.some((provider) => provider.id === providerId))
            throw new SecureConfigError('provider-not-found');
        state.activeProviderId = providerId;
        await this.writeState(state);
    }

    async getSettings(): Promise<SettingsState> {
        const state = await this.readState();
        return {
            activeProviderId: state.activeProviderId,
            preferences: state.preferences ?? DEFAULT_SETTINGS_PREFERENCES
        };
    }

    async saveSettings(preferences: SettingsPreferences): Promise<SettingsState> {
        const parsed = settingsPreferencesSchema.safeParse(preferences);
        if (!parsed.success)
            throw new SecureConfigError('invalid-config');
        const state = await this.readState();
        state.preferences = parsed.data;
        await this.writeState(state);
        return {
            activeProviderId: state.activeProviderId,
            preferences: parsed.data
        };
    }

    async testProvider(
        providerId: string,
        capability: 'text' | 'vision',
        options: TestProviderOptions = {}
    ): Promise<ConnectionTestResult> {
        const startedAt = Date.now();
        try {
            const provider = await this.getProviderForTest(providerId);
            const client = options.fetchImpl === undefined
                ? this.openAiClient
                : new OpenAiClient({ fetchImpl: options.fetchImpl });

            if (capability === 'text') {
                await client.translateText({
                    provider,
                    sourceText: 'Reply with OK.',
                    targetLanguage: 'English'
                }, options.signal);
            } else {
                await client.translateImage({
                    provider,
                    image: getVisionProbeImage(),
                    targetLanguage: 'English'
                }, options.signal);
            }

            return {
                capability,
                success: true,
                message: 'Connection test passed.',
                latencyMs: Math.max(0, Date.now() - startedAt)
            };
        } catch (error) {
            return {
                capability,
                success: false,
                message: safeErrorMessage(error),
                errorCode: safeErrorCode(error)
            };
        }
    }

    private async getProviderForTest(providerId: string): Promise<ProviderConfig> {
        const storedProvider = (await this.readState()).providers.find(
            (provider) => provider.id === providerId
        );
        if (storedProvider === undefined)
            throw new SecureConfigError('provider-not-found');

        let apiKey: string;
        try {
            apiKey = this.safeStorage.decryptString(
                Buffer.from(storedProvider.encryptedApiKey, 'base64')
            );
        } catch {
            throw new SecureConfigError('storage-error');
        }

        return validateProviderConfig({
            id: storedProvider.id,
            name: storedProvider.name,
            baseUrl: storedProvider.baseUrl,
            apiKey,
            textModel: storedProvider.textModel,
            visionModel: storedProvider.visionModel,
            systemPrompt: storedProvider.systemPrompt,
            targetLanguage: storedProvider.targetLanguage,
            timeoutMs: storedProvider.timeoutMs,
            streaming: storedProvider.streaming
        });
    }

    private async readState(): Promise<StoredState> {
        let raw: string;
        try {
            raw = await readFile(this.storagePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return {
                    version: 1,
                    providers: []
                };
            throw new SecureConfigError('storage-error');
        }

        try {
            const persisted = persistedStateSchema.parse(JSON.parse(raw));
            return Array.isArray(persisted)
                ? {
                    version: 1,
                    providers: persisted
                }
                : persisted;
        } catch {
            throw new SecureConfigError('invalid-storage');
        }
    }

    private async writeState(state: StoredState): Promise<void> {
        const temporaryPath = `${this.storagePath}.${randomUUID()}.tmp`;
        try {
            await mkdir(dirname(this.storagePath), { recursive: true });
            await writeFile(temporaryPath, JSON.stringify(state), {
                encoding: 'utf8',
                mode: 0o600
            });
            await rename(temporaryPath, this.storagePath);
        } catch {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            throw new SecureConfigError('storage-error');
        }
    }
}

function toProviderSummary(provider: StoredProvider): ProviderSummary {
    return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        hasApiKey: provider.encryptedApiKey.length > 0,
        textModel: provider.textModel,
        visionModel: provider.visionModel
    };
}

function safeErrorMessage(error: unknown): string {
    if (error instanceof ProviderError || error instanceof SecureConfigError)
        return error.message;
    return 'Provider request failed.';
}

function safeErrorCode(error: unknown): ProviderErrorCode {
    if (error instanceof ProviderError || error instanceof SecureConfigError)
        return error.code;
    return 'network';
}

let defaultService: Promise<SecureConfigService> | undefined;

async function getDefaultService(): Promise<SecureConfigService> {
    defaultService ??= import('electron').then(async ({ app, safeStorage }) => {
        if (!app.isReady())
            await app.whenReady();
        return new SecureConfigService({
            storagePath: join(app.getPath('userData'), 'provider-settings.json'),
            safeStorage
        });
    });
    return defaultService;
}

export function createSecureConfigService(
    options: SecureConfigServiceOptions
): SecureConfigService {
    return new SecureConfigService(options);
}

export async function saveProvider(config: ProviderSaveConfig): Promise<ProviderSummary> {
    return (await getDefaultService()).saveProvider(config);
}

export async function deleteProvider(providerId: string): Promise<void> {
    await (await getDefaultService()).deleteProvider(providerId);
}

export async function setActiveProvider(providerId: string): Promise<void> {
    await (await getDefaultService()).setActiveProvider(providerId);
}

export async function getSettings(): Promise<SettingsState> {
    return (await getDefaultService()).getSettings();
}

export async function saveSettings(
    preferences: SettingsPreferences
): Promise<SettingsState> {
    return (await getDefaultService()).saveSettings(preferences);
}

export async function getProviderSummaries(): Promise<ProviderSummary[]> {
    return (await getDefaultService()).getProviderSummaries();
}

export async function getProviderDetails(providerId: string): Promise<ProviderDetails> {
    return (await getDefaultService()).getProviderDetails(providerId);
}

export async function getActiveProviderConfig(): Promise<ProviderConfig> {
    return (await getDefaultService()).getActiveProviderConfig();
}

export async function testProvider(
    providerId: string,
    capability: 'text' | 'vision',
    options: TestProviderOptions = {}
): Promise<ConnectionTestResult> {
    return (await getDefaultService()).testProvider(providerId, capability, options);
}
