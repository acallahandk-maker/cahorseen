import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_CAPTURED_IMAGE_BYTES,
    type CapturedImage,
    type ProviderConfig
} from '../../src/shared/contracts';
import type { ImageTranslationRunner } from '../../src/main/workers/translationWorker';
import {
    ScreenshotError,
    ScreenshotService,
    disposeCapturedImage,
    type EncodedScreenshot,
    type ScreenshotCaptureAdapter,
    type ScreenshotCaptureRequest
} from '../../src/main/services/screenshotService';

const provider: ProviderConfig = {
    name: 'Synthetic',
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'synthetic-key',
    textModel: 'text-model',
    visionModel: 'vision-model',
    targetLanguage: 'zh-CN'
};

const fileWrites = vi.hoisted(() => ({
    writeFile: vi.fn(),
    writeFileSync: vi.fn(),
    promisesWriteFile: vi.fn()
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        writeFile: fileWrites.writeFile,
        writeFileSync: fileWrites.writeFileSync,
        promises: {
            ...actual.promises,
            writeFile: fileWrites.promisesWriteFile
        }
    };
});

function imageResult(width = 10, height = 10, data = Buffer.from('synthetic-image')): EncodedScreenshot {
    return {
        data,
        mimeType: 'image/jpeg',
        width,
        height
    };
}

function runner(): ImageTranslationRunner {
    return {
        runImage: vi.fn(async () => ({
            translatedText: 'translated',
            model: 'vision-model'
        }))
    };
}

function service(
    captureAdapter: ScreenshotCaptureAdapter,
    translationRunner: ImageTranslationRunner = runner(),
    maxDimension = 100
): ScreenshotService {
    return new ScreenshotService({
        captureAdapter,
        translationRunner,
        getProvider: async () => provider,
        getDisplays: () => [{ x: 0, y: 0, width: 100, height: 80 }],
        mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
        maxDimension,
        createId: () => 'screenshot-task'
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ScreenshotService', () => {
    it('clips and downscales only the requested screenshot region', async () => {
        const captureClippedRegion = vi.fn(async (
            request: ScreenshotCaptureRequest
        ) => imageResult(request.width, request.height));
        const testService = service({ captureClippedRegion }, runner(), 50);

        await testService.captureRegion({ x: -20, y: 10, width: 140, height: 100 });

        expect(captureClippedRegion).toHaveBeenCalledTimes(1);
        const request = captureClippedRegion.mock.calls[0][0];
        expect(request.bounds).toEqual({ x: 0, y: 10, width: 100, height: 70 });
        expect(request.width).toBe(50);
        expect(request.height).toBe(35);
        expect(request.segments).toEqual([{
            source: { x: 0, y: 10, width: 100, height: 70 },
            destination: { x: 0, y: 0, width: 50, height: 35 }
        }]);
        expect(testService.activeCaptureCount()).toBe(1);
    });

    it('maps mixed-DPI displays per display and composites only selected segments', async () => {
        const captureClippedRegion = vi.fn(async (
            request: ScreenshotCaptureRequest
        ) => imageResult(request.width, request.height));
        const testService = new ScreenshotService({
            captureAdapter: { captureClippedRegion },
            translationRunner: runner(),
            getProvider: async () => provider,
            getDisplays: () => [
                { x: 0, y: 0, width: 100, height: 100 },
                { x: 100, y: 0, width: 100, height: 100 }
            ],
            mapBoundsToCapturePixels: (displayIndex, bounds) => displayIndex === 0
                ? bounds
                : {
                    x: bounds.x * 2,
                    y: bounds.y * 2,
                    width: bounds.width * 2,
                    height: bounds.height * 2
                },
            maxDimension: 80,
            createId: () => 'screenshot-task'
        });

        await testService.captureRegion({ x: 50, y: 0, width: 80, height: 10 });

        const request = captureClippedRegion.mock.calls[0][0];
        expect(request.segments.map((segment) => segment.source)).toEqual([
            { x: 50, y: 0, width: 50, height: 10 },
            { x: 200, y: 0, width: 60, height: 20 }
        ]);
        expect(request.segments.map((segment) => segment.destination)).toEqual([
            { x: 0, y: 0, width: 50, height: 10 },
            { x: 50, y: 0, width: 30, height: 10 }
        ]);
    });

    it('does not allocate source pixels for separated-monitor gaps', async () => {
        const captureClippedRegion = vi.fn(async (
            request: ScreenshotCaptureRequest
        ) => imageResult(request.width, request.height));
        const testService = new ScreenshotService({
            captureAdapter: { captureClippedRegion },
            translationRunner: runner(),
            getProvider: async () => provider,
            getDisplays: () => [
                { x: 0, y: 0, width: 100, height: 100 },
                { x: 200, y: 0, width: 100, height: 100 }
            ],
            mapBoundsToCapturePixels: (_displayIndex, value) => value,
            maxDimension: 200,
            createId: () => 'screenshot-task'
        });

        await testService.captureRegion({ x: 50, y: 0, width: 200, height: 50 });

        const request = captureClippedRegion.mock.calls[0][0];
        expect(request.segments.map((segment) => segment.source)).toEqual([
            { x: 50, y: 0, width: 50, height: 50 },
            { x: 200, y: 0, width: 50, height: 50 }
        ]);
    });

    it('tiles oversized source regions to enforce the raw-pixel budget', async () => {
        const captureClippedRegion = vi.fn(async (
            request: ScreenshotCaptureRequest
        ) => imageResult(request.width, request.height));
        const testService = new ScreenshotService({
            captureAdapter: { captureClippedRegion },
            translationRunner: runner(),
            getProvider: async () => provider,
            getDisplays: () => [{ x: 0, y: 0, width: 20, height: 10 }],
            mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
            maxDimension: 20,
            maxSourceBytes: 4 * 5 * 5,
            createId: () => 'screenshot-task'
        });

        await testService.captureRegion({ x: 0, y: 0, width: 20, height: 10 });

        const request = captureClippedRegion.mock.calls[0][0];
        expect(request.segments.length).toBeGreaterThan(1);
        expect(request.segments.every((segment) => (
            segment.source.width * segment.source.height * 4 <= 4 * 5 * 5
        ))).toBe(true);
    });

    it('serializes capture requests before allocating source buffers', async () => {
        const pending: Array<() => void> = [];
        let active = 0;
        let maximumActive = 0;
        const captureClippedRegion = vi.fn(async (
            request: ScreenshotCaptureRequest
        ) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => pending.push(resolve));
            active -= 1;
            return imageResult(request.width, request.height);
        });
        const testService = service({ captureClippedRegion });

        const first = testService.captureRegion({ x: 0, y: 0, width: 10, height: 10 });
        const second = testService.captureRegion({ x: 0, y: 0, width: 10, height: 10 });
        await vi.waitFor(() => expect(captureClippedRegion).toHaveBeenCalledTimes(1));
        pending.shift()?.();
        await first;
        await vi.waitFor(() => expect(captureClippedRegion).toHaveBeenCalledTimes(2));
        pending.shift()?.();
        await second;

        expect(maximumActive).toBe(1);
    });

    it('enforces captured image byte limits and disposes oversized buffers', async () => {
        const oversized = imageResult(10, 10, Buffer.alloc(MAX_CAPTURED_IMAGE_BYTES + 1, 7));
        const testService = service({
            captureClippedRegion: vi.fn(async () => oversized)
        });

        await expect(testService.captureRegion(
            { x: 0, y: 0, width: 10, height: 10 }
        )).rejects.toMatchObject({
            name: 'ScreenshotError',
            code: 'image-too-large'
        } satisfies Partial<ScreenshotError>);
        expect(Array.from(oversized.data).every((value) => value === 0)).toBe(true);
        expect(testService.activeCaptureCount()).toBe(0);
    });

    it('releases cached image buffers after explicit disposal', async () => {
        const data = Buffer.from('synthetic-image');
        const testService = service({
            captureClippedRegion: vi.fn(async () => imageResult(10, 10, data))
        });
        const image = await testService.captureRegion({ x: 0, y: 0, width: 10, height: 10 });

        testService.disposeCapturedImage(image);

        expect(Array.from(data).every((value) => value === 0)).toBe(true);
        expect(image.dataUrl).toBe('');
        expect(image.byteLength).toBe(0);
        expect(testService.activeCaptureCount()).toBe(0);
    });

    it('disposes images through the shared disposal interface', async () => {
        const data = Buffer.from('synthetic-image');
        const testService = service({
            captureClippedRegion: vi.fn(async () => imageResult(10, 10, data))
        });
        const image = await testService.captureRegion({ x: 0, y: 0, width: 10, height: 10 });

        disposeCapturedImage(image);

        expect(Array.from(data).every((value) => value === 0)).toBe(true);
        expect(testService.activeCaptureCount()).toBe(0);
    });

    it('does not persist screenshot bytes to disk', async () => {
        const testService = service({
            captureClippedRegion: vi.fn(async () => imageResult())
        });

        const image = await testService.captureRegion({ x: 0, y: 0, width: 10, height: 10 });
        testService.disposeCapturedImage(image);

        expect(fileWrites.writeFile).not.toHaveBeenCalled();
        expect(fileWrites.writeFileSync).not.toHaveBeenCalled();
        expect(fileWrites.promisesWriteFile).not.toHaveBeenCalled();
    });

    it('rejects empty or unclippable bounds before screen capture', async () => {
        const captureClippedRegion = vi.fn(async () => imageResult());
        const testService = service({ captureClippedRegion });

        await expect(testService.captureRegion(
            { x: 200, y: 200, width: 10, height: 10 }
        )).rejects.toMatchObject({
            name: 'ScreenshotError',
            code: 'invalid-bounds'
        } satisfies Partial<ScreenshotError>);
        expect(captureClippedRegion).not.toHaveBeenCalled();
    });

    it('returns a valid captured image contract', async () => {
        const testService = service({
            captureClippedRegion: vi.fn(async () => imageResult(10, 10, Buffer.from('image')))
        });

        const image: CapturedImage = await testService.captureRegion(
            { x: 0, y: 0, width: 10, height: 10 }
        );

        expect(image).toEqual({
            dataUrl: 'data:image/jpeg;base64,aW1hZ2U=',
            mimeType: 'image/jpeg',
            width: 10,
            height: 10,
            byteLength: 5
        });
    });
});
