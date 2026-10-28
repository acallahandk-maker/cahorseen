import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
    type ConnectionTestResult,
    type ProviderErrorCode,
    type ProviderConfig,
    type ProviderSummary
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
const storedStateSchema = z.strictObject({
    version: z.literal(1),
    activeProviderId: z.string().min(1).optional(),
    providers: z.array(storedProviderSchema)
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

    async saveProvider(config: ProviderConfig): Promise<ProviderSummary> {
        let validated: ProviderConfig;
        try {
            validated = validateProviderConfig(config);
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
        const state = await this.readState();
        const existingIndex = state.providers.findIndex((provider) => provider.id === id);
        if (existingIndex >= 0)
            state.providers[existingIndex] = storedProvider;
        else
            state.providers.push(storedProvider);
        state.activeProviderId ??= id;

        await this.writeState(state);
        return toProviderSummary(storedProvider);
    }

    async getProviderSummaries(): Promise<ProviderSummary[]> {
        return (await this.readState()).providers.map(toProviderSummary);
    }

    async setActiveProvider(providerId: string): Promise<void> {
        const state = await this.readState();
        if (!state.providers.some((provider) => provider.id === providerId))
            throw new SecureConfigError('provider-not-found');
        state.activeProviderId = providerId;
        await this.writeState(state);
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
                    image: {
                        dataUrl: 'data:image/png;base64,AA==',
                        mimeType: 'image/png',
                        width: 1,
                        height: 1,
                        byteLength: 1
                    },
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

export async function saveProvider(config: ProviderConfig): Promise<ProviderSummary> {
    return (await getDefaultService()).saveProvider(config);
}

export async function setActiveProvider(providerId: string): Promise<void> {
    await (await getDefaultService()).setActiveProvider(providerId);
}

export async function getProviderSummaries(): Promise<ProviderSummary[]> {
    return (await getDefaultService()).getProviderSummaries();
}

export async function testProvider(
    providerId: string,
    capability: 'text' | 'vision',
    options: TestProviderOptions = {}
): Promise<ConnectionTestResult> {
    return (await getDefaultService()).testProvider(providerId, capability, options);
}
