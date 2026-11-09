import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PROVIDER_PRESETS,
    SecureConfigError,
    createSecureConfigService
} from '../../src/main/services/secureConfig';
import {
    getProductionRendererFileUrl,
    providerIpcChannels,
    registerIpcRouter
} from '../../src/main/ipcRouter';

const SYNTHETIC_API_KEY = 'placeholder-safe-credential';
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
        apiKey: 'placeholder-safe-credential',
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

        const savedSummary = await service.saveProvider(providerConfig('synthetic-provider'));

        const raw = await readFile(join(directory, 'providers.json'), 'utf8');
        expect(raw.includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(raw.includes('apiKey')).toBe(false);
        expect(raw.includes('encryptedApiKey')).toBe(true);

        const summaries = await service.getProviderSummaries();
        const expectedSummary = {
            id: 'synthetic-provider',
            name: 'Synthetic Provider',
            baseUrl: 'https://provider.example/v1',
            hasApiKey: true,
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model'
        };
        expect(savedSummary).toEqual(expectedSummary);
        expect(summaries).toEqual([expectedSummary]);
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

    it('rejects stored provider metadata that downgrades to plaintext HTTP', async () => {
        const { directory, service } = await createService();
        await service.saveProvider(providerConfig('stored-provider'));
        const storagePath = join(directory, 'providers.json');
        const raw = await readFile(storagePath, 'utf8');
        await writeFile(
            storagePath,
            raw.replace('https://provider.example/v1', 'http://provider.example/v1'),
            'utf8'
        );

        await expect(service.getProviderSummaries()).rejects.toMatchObject({
            code: 'invalid-storage'
        });
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

        const result = await service.testProvider('connection-provider', 'text', {
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
            message: 'Provider rate limit exceeded.',
            errorCode: 'rate-limited'
        });
        expect(JSON.stringify(result).includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(JSON.stringify(result).includes('x-api-key')).toBe(false);
    });

    it('persists provider selection and tests the selected provider after restart', async () => {
        const { directory, service } = await createService();
        await service.saveProvider(providerConfig('first-provider'));
        await service.saveProvider({
            ...providerConfig('second-provider'),
            textModel: 'second-text-model'
        });
        await service.setActiveProvider('second-provider');

        const raw = await readFile(join(directory, 'providers.json'), 'utf8');
        expect(raw.includes('"activeProviderId":"second-provider"')).toBe(true);
        expect(raw.includes(SYNTHETIC_API_KEY)).toBe(false);

        const restarted = createSecureConfigService({
            storagePath: join(directory, 'providers.json'),
            safeStorage: fakeSafeStorage()
        });
        let requestedModel = '';
        const result = await restarted.testProvider('second-provider', 'text', {
            fetchImpl: async (_input, init) => {
                requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'ok' } }]
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
        });

        expect(result).toMatchObject({
            capability: 'text',
            success: true,
            message: 'Connection test passed.'
        });
        expect(requestedModel).toBe('second-text-model');
        await expect(restarted.setActiveProvider('missing-provider')).rejects.toMatchObject({
            code: 'provider-not-found'
        });
    });

    it('exposes authoritative active provider state across rollback writes', async () => {
        const { directory, service } = await createService();
        await service.saveProvider(providerConfig('rollback-first'));
        await service.saveProvider(providerConfig('rollback-second'));

        await service.setActiveProvider('rollback-second');
        await service.setActiveProvider('rollback-first');
        const restarted = createSecureConfigService({
            storagePath: join(directory, 'providers.json'),
            safeStorage: fakeSafeStorage()
        });

        await expect(restarted.getSettings()).resolves.toMatchObject({
            activeProviderId: 'rollback-first'
        });
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
            saveProvider: async () => ({
                id: 'ipc-provider',
                name: 'Synthetic Provider',
                baseUrl: 'https://provider.example/v1',
                hasApiKey: true,
                textModel: 'synthetic-text-model',
                visionModel: 'synthetic-vision-model'
            }),
            setActiveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'text' as const,
                success: true as const,
                message: 'Connection test passed.'
            })
        };

        registerIpcRouter({
            ipcMain,
            secureConfig,
            isSenderAuthorized: () => true
        });

        expect([...handlers.keys()].sort()).toEqual([
            'desktop-pet:provider-delete',
            providerIpcChannels.save,
            providerIpcChannels.setActive,
            providerIpcChannels.summaries,
            'desktop-pet:provider-details',
            providerIpcChannels.test,
            'desktop-pet:settings-get',
            'desktop-pet:settings-save'
        ].sort());

        const invalidResult = await handlers.get(providerIpcChannels.save)?.({}, {
            ...providerConfig('invalid-ipc-provider'),
            baseUrl: 'https://user:pass@provider.example/v1'
        });
        expect(invalidResult).toEqual({
            ok: false,
            error: {
                code: 'invalid-config',
                message: 'Provider configuration is invalid.'
            }
        });
        expect(JSON.stringify(invalidResult).includes(SYNTHETIC_API_KEY)).toBe(false);
    });

    it('maps malformed IPC request payloads to invalid-request', async () => {
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
            saveProvider: async () => ({
                id: 'unused-provider',
                name: 'Synthetic Provider',
                baseUrl: 'https://provider.example/v1',
                hasApiKey: true,
                textModel: 'synthetic-text-model',
                visionModel: 'synthetic-vision-model'
            }),
            setActiveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'text' as const,
                success: true as const,
                message: 'Connection test passed.'
            })
        };
        registerIpcRouter({
            ipcMain,
            secureConfig,
            isSenderAuthorized: () => true
        });

        const saveResult = await handlers.get(providerIpcChannels.save)?.({}, {
            name: 'missing required provider fields'
        });
        const setActiveResult = await handlers.get(providerIpcChannels.setActive)?.({}, {});
        const testResult = await handlers.get(providerIpcChannels.test)?.({}, {
            providerId: 'unused-provider',
            capability: 'invalid-capability'
        });

        for (const result of [saveResult, setActiveResult, testResult]) {
            expect(result).toMatchObject({
                ok: false,
                error: { code: 'invalid-request' }
            });
        }
    });

    it('propagates sanitized typed failures through IPC', async () => {
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
            saveProvider: async () => {
                throw new SecureConfigError('storage-unavailable');
            },
            setActiveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'vision' as const,
                success: false as const,
                message: 'Provider authentication failed.',
                errorCode: 'authentication' as const
            })
        };
        registerIpcRouter({
            ipcMain,
            secureConfig,
            isSenderAuthorized: () => true
        });

        const saveResult = await handlers.get(providerIpcChannels.save)?.({}, providerConfig('ipc-provider'));
        expect(saveResult).toEqual({
            ok: false,
            error: {
                code: 'storage-unavailable',
                message: 'Secure storage is unavailable.'
            }
        });

        const testResult = await handlers.get(providerIpcChannels.test)?.({}, {
            providerId: 'ipc-provider',
            capability: 'vision'
        });
        expect(testResult).toEqual({
            ok: true,
            value: {
                capability: 'vision',
                success: false,
                message: 'Provider authentication failed.',
                errorCode: 'authentication'
            }
        });
        expect(JSON.stringify(saveResult).includes(SYNTHETIC_API_KEY)).toBe(false);
    });

    it('does not forward arbitrary internal messages with provider-shaped codes', async () => {
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
            saveProvider: async () => {
                throw Object.assign(
                    new Error(`internal detail ${SYNTHETIC_API_KEY}`),
                    { code: 'storage-error' }
                );
            },
            setActiveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'text' as const,
                success: true as const,
                message: 'Connection test passed.'
            })
        };
        registerIpcRouter({
            ipcMain,
            secureConfig,
            isSenderAuthorized: () => true
        });

        const result = await handlers.get(providerIpcChannels.save)?.({}, providerConfig('privacy-provider'));
        expect(result).toEqual({
            ok: false,
            error: {
                code: 'storage-error',
                message: 'Provider storage could not be updated.'
            }
        });
        expect(JSON.stringify(result).includes(SYNTHETIC_API_KEY)).toBe(false);
        expect(JSON.stringify(result).includes('internal detail')).toBe(false);
    });

    it('authorizes only the production renderer URL and exact configured renderer URL', async () => {
        const previousRendererUrl = process.env.ELECTRON_RENDERER_URL;
        const configuredRendererUrl = 'https://configured-renderer.example/translation?panel=main';
        process.env.ELECTRON_RENDERER_URL = configuredRendererUrl;
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
            saveProvider: async () => ({
                id: 'authorized-provider',
                name: 'Synthetic Provider',
                baseUrl: 'https://provider.example/v1',
                hasApiKey: true,
                textModel: 'synthetic-text-model',
                visionModel: 'synthetic-vision-model'
            }),
            setActiveProvider: async () => undefined,
            getProviderSummaries: async () => [],
            testProvider: async () => ({
                capability: 'text' as const,
                success: true as const,
                message: 'Connection test passed.'
            })
        };
        registerIpcRouter({ ipcMain, secureConfig });
        const saveHandler = handlers.get(providerIpcChannels.save);

        try {
            await expect(saveHandler?.({
                senderFrame: { url: getProductionRendererFileUrl() }
            }, providerConfig('authorized-provider'))).resolves.toMatchObject({ ok: true });
            await expect(saveHandler?.({
                senderFrame: { url: configuredRendererUrl }
            }, providerConfig('authorized-provider'))).resolves.toMatchObject({ ok: true });

            for (const url of [
                'file:///C:/other/index.html',
                'app://other/index.html',
                'http://localhost:5173/index.html',
                `${configuredRendererUrl}/other`
            ]) {
                await expect(saveHandler?.({
                    senderFrame: { url }
                }, providerConfig('authorized-provider'))).resolves.toEqual({
                    ok: false,
                    error: {
                        code: 'unauthorized',
                        message: 'IPC sender is not authorized.'
                    }
                });
            }
        } finally {
            if (previousRendererUrl === undefined)
                delete process.env.ELECTRON_RENDERER_URL;
            else
                process.env.ELECTRON_RENDERER_URL = previousRendererUrl;
        }
    });
});
