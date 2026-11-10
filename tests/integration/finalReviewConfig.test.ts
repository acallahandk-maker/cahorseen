import { mkdtempSync, rmSync } from 'node:fs';
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

function assertPngDecoderValidity(image: Buffer): void {
    expect(image.subarray(0, 8)).toEqual(Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    ]));
    expect(image.readUInt32BE(8)).toBe(13);
    expect(image.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(image.readUInt32BE(16)).toBe(1);
    expect(image.readUInt32BE(20)).toBe(1);
    expect(image.subarray(image.length - 8, image.length - 4).toString('ascii')).toBe('IEND');
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
