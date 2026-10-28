import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PROVIDER_PRESETS,
    SecureConfigError,
    createSecureConfigService
} from '../../src/main/services/secureConfig';
import {
    providerIpcChannels,
    registerIpcRouter
} from '../../src/main/ipcRouter';

const SYNTHETIC_API_KEY = 'sk-synthetic-test-only-123';
const temporaryDirectories: string[] = [];

function fakeSafeStorage() {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(
            Array.from(value, (character) => character.charCodeAt(0) ^ 0x5a)
        ),
        decryptString: (value: Buffer) => String.fromCharCode(
            ...Array.from(value, (byte) => byte ^ 0x5a)
        )
    };
}

function providerConfig(id: string) {
    return {
        id,
        name: 'Synthetic Provider',
        baseUrl: 'https://provider.example/v1',
        apiKey: SYNTHETIC_API_KEY,
        textModel: 'synthetic-text-model',
        visionModel: 'synthetic-vision-model',
        timeoutMs: 1_000
    };
}

async function createService() {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-secure-config-'));
    temporaryDirectories.push(directory);
    return {
        directory,
        service: createSecureConfigService({
            storagePath: join(directory, 'providers.json'),
            safeStorage: fakeSafeStorage()
        })
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true
    })));
});

describe('secure provider configuration', () => {
    it('stores API keys only as safeStorage ciphertext and masks summaries', async () => {
        const { directory, service } = await createService();

        await service.saveProvider(providerConfig('synthetic-provider'));

        const raw = await readFile(join(directory, 'providers.json'), 'utf8');
        expect(raw.includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(raw.includes('apiKey')).toBe(false);
        expect(raw.includes('encryptedApiKey')).toBe(true);

        const summaries = await service.getProviderSummaries();
        expect(summaries).toEqual([{
            id: 'synthetic-provider',
            name: 'Synthetic Provider',
            baseUrl: 'https://provider.example/v1',
            hasApiKey: true,
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model'
        }]);
        expect(JSON.stringify(summaries).includes(SYNTHETIC_API_KEY)).toBe(false);
    });

    it('rejects invalid provider settings without persisting a key', async () => {
        const { directory, service } = await createService();

        await expect(service.saveProvider({
            ...providerConfig('invalid-provider'),
            baseUrl: 'file:///tmp/provider'
        })).rejects.toBeInstanceOf(SecureConfigError);

        const raw = await readFile(join(directory, 'providers.json'), 'utf8').catch(() => '');
        expect(raw.includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(raw.includes('encryptedApiKey')).toBe(false);
    });

    it('requires bounded timeouts and safe editable Base URLs', async () => {
        const { service } = await createService();

        await expect(service.saveProvider({
            ...providerConfig('too-slow'),
            timeoutMs: 120_001
        })).rejects.toMatchObject({ code: 'invalid-config' });
        await expect(service.saveProvider({
            ...providerConfig('credentials-in-url'),
            baseUrl: 'https://user:pass@provider.example/v1'
        })).rejects.toMatchObject({ code: 'invalid-config' });
    });

    it('exposes the Mimo preset and leaves DeepSeek endpoint editable', () => {
        expect(PROVIDER_PRESETS).toEqual([
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
        ]);
    });

    it('returns a safe typed connection error for provider failures', async () => {
        const { service } = await createService();
        await service.saveProvider(providerConfig('connection-provider'));

        const result = await service.testProvider('text', {
            fetchImpl: async () => new Response(JSON.stringify({
                error: {
                    message: `do not expose ${SYNTHETIC_API_KEY}`
                }
            }), {
                status: 429,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': SYNTHETIC_API_KEY
                }
            })
        });

        expect(result).toEqual({
            capability: 'text',
            success: false,
            message: 'Provider rate limit exceeded.'
        });
        expect(JSON.stringify(result).includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(JSON.stringify(result).includes('x-api-key')).toBe(false);
    });

    it('registers typed provider IPC handlers without leaking rejected payloads', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const secureConfig = {
            saveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'text' as const,
                success: true,
                message: 'Connection test passed.'
            })
        };

        registerIpcRouter({
            ipcMain,
            secureConfig,
            isSenderAuthorized: () => true
        });

        expect([...handlers.keys()].sort()).toEqual([
            providerIpcChannels.save,
            providerIpcChannels.summaries,
            providerIpcChannels.test
        ].sort());

        const invalidResult = await handlers.get(providerIpcChannels.save)?.({}, {
            ...providerConfig('invalid-ipc-provider'),
            baseUrl: 'file:///tmp/provider'
        });
        expect(invalidResult).toEqual({
            ok: false,
            error: {
                code: 'invalid-request',
                message: 'Provider configuration is invalid.'
            }
        });
        expect(JSON.stringify(invalidResult).includes(SYNTHETIC_API_KEY)).toBe(false);
    });
});
