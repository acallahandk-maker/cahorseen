import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
    MAX_CAPTURED_IMAGE_BYTES,
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    capturedImageSchema,
    screenBoundsSchema,
    type CapturedImage,
    type MemoryPersistenceStatus,
    type ProviderConfig,
    type ScreenBounds,
    type TranslationErrorCode,
    type TranslationTask
} from '../../shared/contracts';
import {
    ProviderError,
    providerErrorMessage
} from './openAiClient';
import {
    TranslationWorkerRunner,
    UnsupportedVisionError,
    type ImageTranslationRunner,
    type ImageTranslationRunnerRequest
} from '../workers/translationWorker';
import { getActiveProviderConfig } from './secureConfig';
import {
    MemoryDatabaseError,
    memoryFailureStatus,
    memoryRecordedStatus,
    recordTranslation as recordTranslationMemory
} from './memoryDatabase';

export type { ImageTranslationRunner };
export { UnsupportedVisionError };

export const MAX_CAPTURE_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_CAPTURE_MEMORY_BYTES = 320 * 1024 * 1024;

export interface EncodedScreenshot {
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    width: number;
    height: number;
}

export interface CaptureSegment {
    source: ScreenBounds;
    destination: ScreenBounds;
}

export interface ScreenshotCaptureRequest {
    bounds: ScreenBounds;
    segments: CaptureSegment[];
    width: number;
    height: number;
    mimeType: 'image/jpeg';
    signal?: AbortSignal;
}

export interface ScreenshotCaptureAdapter {
    captureClippedRegion(request: ScreenshotCaptureRequest): Promise<EncodedScreenshot>;
}

export interface ScreenshotServiceOptions {
    captureAdapter: ScreenshotCaptureAdapter;
    translationRunner: ImageTranslationRunner;
    getProvider(): Promise<ProviderConfig>;
    getDisplays(): ScreenBounds[];
    mapBoundsToCapturePixels(displayIndex: number, bounds: ScreenBounds): ScreenBounds;
    maxDimension?: number;
    maxSourceBytes?: number;
    createId?: () => string;
    recordTranslation?: (task: TranslationTask) => Promise<void>;
    onMemoryStatus?: (status: MemoryPersistenceStatus) => void;
}

export interface ScreenshotTranslationOptions {
    taskId?: string;
    signal?: AbortSignal;
    targetLanguage?: string;
    context?: string;
    onTaskId?: (taskId: string) => void;
}

export type ScreenshotErrorCode =
    | 'invalid-bounds'
    | 'capture-failed'
    | 'image-too-large'
    | 'aborted'
    | 'unsupported-vision';

export class ScreenshotError extends Error {
    readonly code: ScreenshotErrorCode;

    constructor(code: ScreenshotErrorCode) {
        super(screenshotErrorMessage(code));
        this.name = 'ScreenshotError';
        this.code = code;
    }
}

interface TrackedCapture {
    data: Buffer;
    image: CapturedImage;
    release(): void;
}

const trackedCaptures = new WeakMap<CapturedImage, TrackedCapture>();

function screenshotErrorMessage(code: ScreenshotErrorCode): string {
    switch (code) {
        case 'invalid-bounds':
            return 'The requested screenshot region is invalid.';
        case 'capture-failed':
            return 'The requested screen region could not be captured.';
        case 'image-too-large':
            return 'The captured screenshot is too large to translate.';
        case 'aborted':
            return 'Screenshot capture was cancelled.';
        case 'unsupported-vision':
            return 'Vision translation is not supported. Choose a vision-capable model.';
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (
        error.name === 'AbortError'
        || (error as Error & { code?: unknown }).code === 'ABORT_ERR'
    );
}

function intersectBounds(bounds: ScreenBounds, clippingBounds: ScreenBounds): ScreenBounds | undefined {
    const left = Math.max(bounds.x, clippingBounds.x);
    const top = Math.max(bounds.y, clippingBounds.y);
    const right = Math.min(bounds.x + bounds.width, clippingBounds.x + clippingBounds.width);
    const bottom = Math.min(bounds.y + bounds.height, clippingBounds.y + clippingBounds.height);
    const width = Math.floor(right - left);
    const height = Math.floor(bottom - top);
    if (width < 1 || height < 1)
        return undefined;
    return {
        x: Math.floor(left),
        y: Math.floor(top),
        width,
        height
    };
}

function scaledDimensions(bounds: ScreenBounds, maxDimension: number): {
    width: number;
    height: number;
} {
    const scale = Math.min(1, maxDimension / bounds.width, maxDimension / bounds.height);
    return {
        width: Math.max(1, Math.round(bounds.width * scale)),
        height: Math.max(1, Math.round(bounds.height * scale))
    };
}

function targetRect(
    source: ScreenBounds,
    clippingBounds: ScreenBounds,
    output: { width: number; height: number }
): ScreenBounds {
    const left = Math.round(
        ((source.x - clippingBounds.x) / clippingBounds.width) * output.width
    );
    const top = Math.round(
        ((source.y - clippingBounds.y) / clippingBounds.height) * output.height
    );
    const right = Math.round(
        ((source.x + source.width - clippingBounds.x) / clippingBounds.width)
        * output.width
    );
    const bottom = Math.round(
        ((source.y + source.height - clippingBounds.y) / clippingBounds.height)
        * output.height
    );
    return {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
}

function tileSegments(
    mapped: ScreenBounds,
    destination: ScreenBounds,
    maxSourceBytes: number
): CaptureSegment[] {
    const maximumPixels = Math.max(1, Math.floor(maxSourceBytes / 4));
    const tileDimension = Math.max(1, Math.floor(Math.sqrt(maximumPixels)));
    const segments: CaptureSegment[] = [];
    for (let sourceY = 0; sourceY < mapped.height; sourceY += tileDimension) {
        const sourceHeight = Math.min(tileDimension, mapped.height - sourceY);
        for (let sourceX = 0; sourceX < mapped.width; sourceX += tileDimension) {
            const sourceWidth = Math.min(tileDimension, mapped.width - sourceX);
            const destinationLeft = destination.x + Math.round(
                (sourceX / mapped.width) * destination.width
            );
            const destinationTop = destination.y + Math.round(
                (sourceY / mapped.height) * destination.height
            );
            const destinationRight = destination.x + Math.round(
                ((sourceX + sourceWidth) / mapped.width) * destination.width
            );
            const destinationBottom = destination.y + Math.round(
                ((sourceY + sourceHeight) / mapped.height) * destination.height
            );
            segments.push({
                source: {
                    x: mapped.x + sourceX,
                    y: mapped.y + sourceY,
                    width: sourceWidth,
                    height: sourceHeight
                },
                destination: {
                    x: destinationLeft,
                    y: destinationTop,
                    width: Math.max(1, destinationRight - destinationLeft),
                    height: Math.max(1, destinationBottom - destinationTop)
                }
            });
        }
    }
    return segments;
}

function buildCaptureSegments(
    clippedBounds: ScreenBounds,
    displays: ScreenBounds[],
    mapBoundsToCapturePixels: (displayIndex: number, bounds: ScreenBounds) => ScreenBounds,
    output: { width: number; height: number },
    maxSourceBytes: number
): CaptureSegment[] {
    const segments: CaptureSegment[] = [];
    displays.forEach((display, displayIndex) => {
        const displayRegion = intersectBounds(clippedBounds, display);
        if (displayRegion === undefined)
            return;
        const mapped = mapBoundsToCapturePixels(displayIndex, displayRegion);
        if (!screenBoundsSchema.safeParse(mapped).success)
            throw new ScreenshotError('invalid-bounds');
        segments.push(...tileSegments(
            mapped,
            targetRect(displayRegion, clippedBounds, output),
            maxSourceBytes
        ));
    });
    if (segments.length === 0)
        throw new ScreenshotError('invalid-bounds');
    return segments;
}

function safeTaskErrorCode(error: unknown): TranslationErrorCode {
    if (error instanceof ScreenshotError && error.code === 'unsupported-vision')
        return error.code;
    if (error instanceof UnsupportedVisionError)
        return error.code;
    if (error instanceof ScreenshotError)
        return error.code === 'invalid-bounds'
            ? 'invalid-request'
            : error.code === 'capture-failed' || error.code === 'image-too-large'
                ? 'request-failed'
                : error.code;
    if (error instanceof ProviderError)
        return error.code;
    return 'request-failed';
}

function safeTaskError(error: unknown): string {
    if (error instanceof ScreenshotError || error instanceof UnsupportedVisionError)
        return error.message;
    if (error instanceof ProviderError)
        return providerErrorMessage(error.code);
    return 'Provider request failed.';
}

function releaseCapture(capture: TrackedCapture | undefined): void {
    if (capture === undefined)
        return;
    capture.data.fill(0);
    capture.image.dataUrl = '';
    capture.image.byteLength = 0;
    trackedCaptures.delete(capture.image);
    capture.release();
}

function validateCaptureRequest(request: ScreenshotCaptureRequest): void {
    const parsed = screenBoundsSchema.safeParse(request.bounds);
    if (
        !parsed.success
        || request.segments.length === 0
        || request.segments.some((segment) => (
            !screenBoundsSchema.safeParse(segment.source).success
            || !screenBoundsSchema.safeParse(segment.destination).success
        ))
        || !Number.isInteger(request.width)
        || !Number.isInteger(request.height)
        || request.width < 1
        || request.height < 1
    )
        throw new ScreenshotError('invalid-bounds');
}

export class ScreenshotService {
    private readonly captureAdapter: ScreenshotCaptureAdapter;
    private readonly translationRunner: ImageTranslationRunner;
    private readonly getProvider: () => Promise<ProviderConfig>;
    private readonly getDisplays: () => ScreenBounds[];
    private readonly mapBoundsToCapturePixels: (
        displayIndex: number,
        bounds: ScreenBounds
    ) => ScreenBounds;
    private readonly maxDimension: number;
    private readonly maxSourceBytes: number;
    private readonly createId: () => string;
    private readonly recordTranslation: ((task: TranslationTask) => Promise<void>) | undefined;
    private readonly onMemoryStatus: ((status: MemoryPersistenceStatus) => void) | undefined;
    private readonly captures = new Set<CapturedImage>();
    private captureQueue: Promise<void> = Promise.resolve();

    constructor(options: ScreenshotServiceOptions) {
        const maxDimension = options.maxDimension ?? 1600;
        const maxSourceBytes = options.maxSourceBytes ?? MAX_CAPTURE_SOURCE_BYTES;
        if (!Number.isInteger(maxDimension) || maxDimension < 1 || maxDimension > 4096)
            throw new ScreenshotError('invalid-bounds');
        if (
            !Number.isInteger(maxSourceBytes)
            || maxSourceBytes < 4
            || maxSourceBytes > MAX_CAPTURE_SOURCE_BYTES
        )
            throw new ScreenshotError('image-too-large');
        this.captureAdapter = options.captureAdapter;
        this.translationRunner = options.translationRunner;
        this.getProvider = options.getProvider;
        this.getDisplays = options.getDisplays;
        this.mapBoundsToCapturePixels = options.mapBoundsToCapturePixels;
        this.maxDimension = maxDimension;
        this.maxSourceBytes = maxSourceBytes;
        this.createId = options.createId ?? randomUUID;
        this.recordTranslation = options.recordTranslation;
        this.onMemoryStatus = options.onMemoryStatus;
    }

    activeCaptureCount(): number {
        return this.captures.size;
    }

    async captureRegion(bounds: ScreenBounds, signal?: AbortSignal): Promise<CapturedImage> {
        const capture = this.captureQueue.then(() => this.captureRegionNow(bounds, signal));
        this.captureQueue = capture.then(() => undefined, () => undefined);
        return capture;
    }

    private async captureRegionNow(
        bounds: ScreenBounds,
        signal?: AbortSignal
    ): Promise<CapturedImage> {
        if (!screenBoundsSchema.safeParse(bounds).success)
            throw new ScreenshotError('invalid-bounds');
        if (signal?.aborted === true)
            throw new ScreenshotError('aborted');
        const displays = this.getDisplays();
        if (!Array.isArray(displays) || displays.length === 0)
            throw new ScreenshotError('invalid-bounds');
        const clippedDisplays = displays
            .map((display) => intersectBounds(bounds, display))
            .filter((display): display is ScreenBounds => display !== undefined);
        if (clippedDisplays.length === 0)
            throw new ScreenshotError('invalid-bounds');
        const left = Math.min(...clippedDisplays.map((display) => display.x));
        const top = Math.min(...clippedDisplays.map((display) => display.y));
        const right = Math.max(...clippedDisplays.map((
            display
        ) => display.x + display.width));
        const bottom = Math.max(...clippedDisplays.map((
            display
        ) => display.y + display.height));
        const clippedBounds = {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top
        };

        const dimensions = scaledDimensions(clippedBounds, this.maxDimension);
        const segments = buildCaptureSegments(
            clippedBounds,
            displays,
            this.mapBoundsToCapturePixels,
            dimensions,
            this.maxSourceBytes
        );
        const targetBytes = dimensions.width * dimensions.height * 4;
        const maximumSourceBytes = Math.max(...segments.map((segment) => (
            segment.source.width * segment.source.height * 4
        )));
        if (
            targetBytes + maximumSourceBytes + MAX_CAPTURED_IMAGE_BYTES * 2
            > MAX_CAPTURE_MEMORY_BYTES
        )
            throw new ScreenshotError('image-too-large');
        const captureRequest: ScreenshotCaptureRequest = {
            bounds: clippedBounds,
            segments,
            width: dimensions.width,
            height: dimensions.height,
            mimeType: 'image/jpeg',
            signal
        };
        validateCaptureRequest(captureRequest);

        let encoded: EncodedScreenshot;
        try {
            encoded = await this.captureAdapter.captureClippedRegion(captureRequest);
        } catch (error) {
            if ((signal?.aborted ?? false) || isAbortError(error))
                throw new ScreenshotError('aborted');
            if (error instanceof ScreenshotError)
                throw error;
            throw new ScreenshotError('capture-failed');
        }
        const tracked: TrackedCapture = {
            data: encoded.data,
            image: {
                dataUrl: '',
                mimeType: encoded.mimeType,
                width: encoded.width,
                height: encoded.height,
                byteLength: encoded.data.byteLength
            },
            release: () => undefined
        };
        tracked.release = () => {
            this.captures.delete(tracked.image);
        };

        try {
            if (
                (signal?.aborted ?? false)
                || encoded.data.byteLength === 0
                || encoded.data.byteLength > MAX_CAPTURED_IMAGE_BYTES
                || encoded.width > this.maxDimension
                || encoded.height > this.maxDimension
            )
                throw new ScreenshotError((signal?.aborted ?? false) ? 'aborted' : 'image-too-large');
            tracked.image.dataUrl = `data:${encoded.mimeType};base64,${encoded.data.toString('base64')}`;
            const parsedImage = capturedImageSchema.parse(tracked.image);
            tracked.image = parsedImage;
            trackedCaptures.set(parsedImage, tracked);
            this.captures.add(parsedImage);
            return parsedImage;
        } catch (error) {
            releaseCapture(tracked);
            if (error instanceof ScreenshotError)
                throw error;
            throw new ScreenshotError('image-too-large');
        }
    }

    disposeCapturedImage(image: CapturedImage): void {
        releaseCapture(trackedCaptures.get(image));
        this.forgetCapturedImage(image);
    }

    forgetCapturedImage(image: CapturedImage): void {
        this.captures.delete(image);
    }

    async translateScreenshot(
        bounds: ScreenBounds,
        options: ScreenshotTranslationOptions = {}
    ): Promise<TranslationTask> {
        const taskId = options.taskId ?? this.createId();
        options.onTaskId?.(taskId);
        const sourceText = 'Screenshot region';
        let targetLanguage = 'und';
        let provider: ProviderConfig | undefined;
        let image: CapturedImage | undefined;

        try {
            provider = await this.getProvider();
            const requestedLanguage = options.targetLanguage ?? provider.targetLanguage ?? '';
            if (
                requestedLanguage.length === 0
                || requestedLanguage.length > MAX_TARGET_LANGUAGE_CHARS
                || (options.context?.length ?? 0) > MAX_CONTEXT_CHARS
            )
                throw new ProviderError('invalid-config');
            targetLanguage = requestedLanguage;
            image = await this.captureRegion(bounds, options.signal);
            const request: ImageTranslationRunnerRequest = {
                kind: 'image',
                taskId,
                provider,
                image,
                context: options.context,
                targetLanguage,
                structuredResponse: this.recordTranslation !== undefined
            };
            const result = await this.translationRunner.runImage(request, options.signal);
            return this.persistCompletedTask({
                id: taskId,
                status: 'completed',
                kind: 'screenshot',
                sourceText,
                retryInput: {
                    kind: 'screenshot',
                    strategy: 'recapture',
                    bounds
                },
                translatedText: result.translatedText,
                sourceLanguage: 'und',
                targetLanguage,
                bounds,
                ...(provider.id === undefined ? {} : { providerId: provider.id }),
                providerName: provider.name,
                textModel: provider.textModel,
                visionModel: provider.visionModel,
                translationModel: result.model
            }, result.sourceText);
        } catch (error) {
            return {
                id: taskId,
                status: 'failed',
                kind: 'screenshot',
                sourceText,
                retryInput: {
                    kind: 'screenshot',
                    strategy: 'recapture',
                    bounds
                },
                translatedText: '',
                sourceLanguage: 'und',
                targetLanguage,
                bounds,
                ...(provider?.id === undefined ? {} : { providerId: provider.id }),
                ...(provider === undefined ? {} : {
                    providerName: provider.name,
                    textModel: provider.textModel,
                    visionModel: provider.visionModel
                }),
                error: safeTaskError(error),
                errorCode: safeTaskErrorCode(error)
            };
        } finally {
            if (image !== undefined)
                this.disposeCapturedImage(image);
        }
    }

    private async persistCompletedTask(
        task: TranslationTask,
        memorySourceText?: string
    ): Promise<TranslationTask> {
        if (this.recordTranslation === undefined)
            return task;
        let taskToRecord = task;
        if (task.kind === 'screenshot') {
            const sourceText = memorySourceText?.trim();
            if (
                sourceText === undefined
                || sourceText.length === 0
                || sourceText.length > MAX_SOURCE_TEXT_CHARS
            ) {
                const status = memoryFailureStatus(new MemoryDatabaseError(
                    'invalid-request',
                    'Screenshot memory requires useful source text.'
                ));
                this.notifyMemoryStatus(status);
                return { ...task, memoryStatus: status };
            }
            taskToRecord = { ...task, sourceText };
        }
        try {
            await this.recordTranslation(taskToRecord);
            this.notifyMemoryStatus(memoryRecordedStatus());
            return task;
        } catch (error) {
            const status = memoryFailureStatus(error);
            this.notifyMemoryStatus(status);
            return { ...task, memoryStatus: status };
        }
    }

    private notifyMemoryStatus(status: MemoryPersistenceStatus): void {
        try {
            this.onMemoryStatus?.(status);
        } catch {
            return;
        }
    }
}

function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')
        ], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            signal,
            windowsHide: true
        }, (error, stdout) => {
            if (error !== null) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function captureScript(request: ScreenshotCaptureRequest): string {
    const segmentCommands = request.segments.flatMap((segment) => [
        '  $source = New-Object System.Drawing.Bitmap ' + segment.source.width + ', ' + segment.source.height,
        '  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)',
        '  try {',
        '    $sourceGraphics.CopyFromScreen(' + segment.source.x + ', ' + segment.source.y + ', 0, 0, $source.Size)',
        '    $targetGraphics.DrawImage($source, ' + segment.destination.x + ', ' + segment.destination.y + ', ' + segment.destination.width + ', ' + segment.destination.height + ')',
        '  } finally {',
        '    $sourceGraphics.Dispose()',
        '    $source.Dispose()',
        '  }'
    ]);
    return [
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -TypeDefinition "using System.Runtime.InteropServices; public static class DesktopPetDpi { [DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); }"',
        '[DesktopPetDpi]::SetProcessDPIAware() | Out-Null',
        '$target = New-Object System.Drawing.Bitmap ' + request.width + ', ' + request.height,
        '$targetGraphics = [System.Drawing.Graphics]::FromImage($target)',
        '$memory = New-Object System.IO.MemoryStream',
        'try {',
        '  $targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        ...segmentCommands,
        '  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
        '  $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)',
        '  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)',
        '  $target.Save($memory, $codec, $parameters)',
        '  [Console]::Out.Write([Convert]::ToBase64String($memory.ToArray()))',
        '} finally {',
        '  $memory.Dispose()',
        '  $targetGraphics.Dispose()',
        '  $target.Dispose()',
        '}'
    ].join('\n');
}

function createWindowsCaptureAdapter(): ScreenshotCaptureAdapter {
    return {
        captureClippedRegion: async (request) => {
            if (process.platform !== 'win32')
                throw new ScreenshotError('capture-failed');
            validateCaptureRequest(request);
            const encoded = await runPowerShell(captureScript(request), request.signal);
            return {
                data: Buffer.from(encoded.trim(), 'base64'),
                mimeType: request.mimeType,
                width: request.width,
                height: request.height
            };
        }
    };
}

let defaultService: ScreenshotService | undefined;

async function getDefaultService(): Promise<ScreenshotService> {
    if (defaultService === undefined) {
        const { screen } = await import('electron');
        defaultService = new ScreenshotService({
            captureAdapter: createWindowsCaptureAdapter(),
            translationRunner: new TranslationWorkerRunner({
                workerPath: join(__dirname, 'translationWorker.js')
            }),
            getProvider: getActiveProviderConfig,
            getDisplays: () => screen.getAllDisplays().map((display) => display.bounds),
            mapBoundsToCapturePixels: (_displayIndex, bounds) => (
                screen.dipToScreenRect(null, bounds)
            ),
            recordTranslation: recordTranslationMemory
        });
    }
    return defaultService;
}

export async function captureRegion(bounds: ScreenBounds): Promise<CapturedImage> {
    return (await getDefaultService()).captureRegion(bounds);
}

export async function translateScreenshot(
    bounds: ScreenBounds,
    options?: ScreenshotTranslationOptions
): Promise<TranslationTask> {
    return (await getDefaultService()).translateScreenshot(bounds, options);
}

export function disposeCapturedImage(image: CapturedImage): void {
    releaseCapture(trackedCaptures.get(image));
    defaultService?.forgetCapturedImage(image);
}
