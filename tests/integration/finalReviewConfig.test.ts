import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createSecureConfigService,
    type SafeStorageLike
} from '../../src/main/services/secureConfig';
import {
    capturedImageSchema,
    type SettingsPreferences
} from '../../src/shared/contracts';

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const nativeImageDecoderPath = join(
    import.meta.dirname,
    '../../scripts/electron-native-image-decoder.cjs'
);
const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY1BYte8/AAT+AogiBwaJAAAAAElFTkSuQmCC',
    'base64'
);

function safeStorage(): SafeStorageLike {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8')
    };
}

function providerConfig() {
    return {
        id: 'vision-provider',
        name: 'Vision Provider',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'placeholder-safe-credential',
        textModel: 'text-model',
        visionModel: 'vision-model',
        timeoutMs: 1_000
    };
}

interface NativeImageDecodeResult {
    width: number;
    height: number;
    isEmpty: boolean;
    bitmapByteLength: number;
    pngByteLength: number;
    sourceDataUrlPrefix: string;
    decodedDataUrlPrefix: string;
}

function decodePngWithElectronNativeImage(image: Buffer): NativeImageDecodeResult {
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
    const stdout = execFileSync(electronPath, [
        nativeImageDecoderPath,
        dataUrl
    ], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true
    });
    return JSON.parse(stdout) as NativeImageDecodeResult;
}

function assertPngDecoderValidity(image: Buffer): void {
    const decoded = decodePngWithElectronNativeImage(image);
    expect(decoded, 'Electron nativeImage must decode the vision probe PNG').toMatchObject({
        width: 1,
        height: 1,
        isEmpty: false
    });
    expect(decoded.bitmapByteLength, 'Decoded 1x1 bitmap must be non-empty').toBeGreaterThan(0);
    expect(decoded.pngByteLength, 'Decoded PNG must re-encode to non-empty bytes').toBeGreaterThan(0);
    expect(decoded.sourceDataUrlPrefix).toBe('data:image/png;base64,');
    expect(decoded.decodedDataUrlPrefix).toBe('data:image/png;base64,');
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

describe('final review configuration boundaries', () => {
    it('uses a MIME-consistent decoder-valid PNG for vision capability detection', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desktop-pet-final-config-'));
        temporaryDirectories.push(directory);
        const service = createSecureConfigService({
            storagePath: join(directory, 'providers.json'),
            safeStorage: safeStorage()
        });
        await service.saveProvider(providerConfig());
        let imageUrl = '';

        const result = await service.testProvider('vision-provider', 'vision', {
            fetchImpl: async (_input, init) => {
                const body = JSON.parse(String(init?.body)) as {
                    messages: Array<{
                        content: Array<{ type: string; image_url?: { url: string } }> | string;
                    }>;
                };
                const imagePart = body.messages
                    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
                    .find((part) => part.type === 'image_url');
                imageUrl = imagePart?.image_url?.url ?? '';
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'OK' } }]
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
        });

        expect(result).toMatchObject({ capability: 'vision', success: true });
        expect(imageUrl.startsWith('data:image/png;base64,')).toBe(true);
        const image = capturedImageSchema.parse({
            dataUrl: imageUrl,
            mimeType: 'image/png',
            width: 1,
            height: 1,
            byteLength: tinyPng.byteLength
        });
        assertPngDecoderValidity(Buffer.from(
            image.dataUrl.slice('data:image/png;base64,'.length),
            'base64'
        ));
    });

    it('round-trips privacy and custom quiz frequency preferences', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desktop-pet-final-settings-'));
        temporaryDirectories.push(directory);
        const service = createSecureConfigService({
            storagePath: join(directory, 'providers.json'),
            safeStorage: safeStorage()
        });
        const preferences = {
            hotkey: 'Ctrl+Shift+T',
            screenshotHotkey: 'Ctrl+Shift+S',
            privacy: {
                saveTranslationHistory: true
            },
            performance: {
                reduceMotion: true,
                pauseWhenFullscreen: true
            },
            quiz: {
                paused: false,
                frequencyWeights: {
                    occurrenceCount: 25,
                    recentOccurrenceCount: 75
                }
            }
        } as unknown as SettingsPreferences;

        await service.saveSettings(preferences);

        expect(await service.getSettings()).toMatchObject({ preferences });
    });
});
