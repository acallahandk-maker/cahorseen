import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
    MAX_CAPTURED_IMAGE_BYTES,
    MAX_CONTEXT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    capturedImageSchema,
    screenBoundsSchema,
    type CapturedImage,
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

export type { ImageTranslationRunner };
export { UnsupportedVisionError };

export interface EncodedScreenshot {
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    width: number;
    height: number;
}

export interface ScreenshotCaptureRequest {
    bounds: ScreenBounds;
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
    getCaptureBounds(): ScreenBounds;
    mapBoundsToCapturePixels(bounds: ScreenBounds): ScreenBounds;
    maxDimension?: number;
    createId?: () => string;
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
    private readonly getCaptureBounds: () => ScreenBounds;
    private readonly mapBoundsToCapturePixels: (bounds: ScreenBounds) => ScreenBounds;
    private readonly maxDimension: number;
    private readonly createId: () => string;
    private readonly captures = new Set<CapturedImage>();

    constructor(options: ScreenshotServiceOptions) {
        const maxDimension = options.maxDimension ?? 1600;
        if (!Number.isInteger(maxDimension) || maxDimension < 1 || maxDimension > 4096)
            throw new ScreenshotError('invalid-bounds');
        this.captureAdapter = options.captureAdapter;
        this.translationRunner = options.translationRunner;
        this.getProvider = options.getProvider;
        this.getCaptureBounds = options.getCaptureBounds;
        this.mapBoundsToCapturePixels = options.mapBoundsToCapturePixels;
        this.maxDimension = maxDimension;
        this.createId = options.createId ?? randomUUID;
    }

    activeCaptureCount(): number {
        return this.captures.size;
    }

    async captureRegion(bounds: ScreenBounds, signal?: AbortSignal): Promise<CapturedImage> {
        validateCaptureRequest({
            bounds,
            width: 1,
            height: 1,
            mimeType: 'image/jpeg'
        });
        if (signal?.aborted === true)
            throw new ScreenshotError('aborted');
        const clippedBounds = intersectBounds(bounds, this.getCaptureBounds());
        if (clippedBounds === undefined)
            throw new ScreenshotError('invalid-bounds');

        const dimensions = scaledDimensions(clippedBounds, this.maxDimension);
        const captureRequest: ScreenshotCaptureRequest = {
            bounds: this.mapBoundsToCapturePixels(clippedBounds),
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
        let image: CapturedImage | undefined;

        try {
            const provider = await this.getProvider();
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
                targetLanguage
            };
            const result = await this.translationRunner.runImage(request, options.signal);
            return {
                id: taskId,
                status: 'completed',
                sourceText,
                translatedText: result.translatedText,
                targetLanguage
            };
        } catch (error) {
            return {
                id: taskId,
                status: 'failed',
                sourceText,
                translatedText: '',
                targetLanguage,
                error: safeTaskError(error),
                errorCode: safeTaskErrorCode(error)
            };
        } finally {
            if (image !== undefined)
                this.disposeCapturedImage(image);
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
    return [
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -TypeDefinition "using System.Runtime.InteropServices; public static class DesktopPetDpi { [DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); }"',
        '[DesktopPetDpi]::SetProcessDPIAware() | Out-Null',
        '$source = New-Object System.Drawing.Bitmap ' + request.bounds.width + ', ' + request.bounds.height,
        '$target = New-Object System.Drawing.Bitmap ' + request.width + ', ' + request.height,
        '$sourceGraphics = [System.Drawing.Graphics]::FromImage($source)',
        '$targetGraphics = [System.Drawing.Graphics]::FromImage($target)',
        '$memory = New-Object System.IO.MemoryStream',
        'try {',
        '  $sourceGraphics.CopyFromScreen(' + request.bounds.x + ', ' + request.bounds.y + ', 0, 0, $source.Size)',
        '  $targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        '  $targetGraphics.DrawImage($source, 0, 0, ' + request.width + ', ' + request.height + ')',
        '  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
        '  $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)',
        '  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)',
        '  $target.Save($memory, $codec, $parameters)',
        '  [Console]::Out.Write([Convert]::ToBase64String($memory.ToArray()))',
        '} finally {',
        '  $memory.Dispose()',
        '  $targetGraphics.Dispose()',
        '  $sourceGraphics.Dispose()',
        '  $target.Dispose()',
        '  $source.Dispose()',
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
            getCaptureBounds: () => {
                const displays = screen.getAllDisplays();
                const left = Math.min(...displays.map((display) => display.bounds.x));
                const top = Math.min(...displays.map((display) => display.bounds.y));
                const right = Math.max(...displays.map((
                    display
                ) => display.bounds.x + display.bounds.width));
                const bottom = Math.max(...displays.map((
                    display
                ) => display.bounds.y + display.bounds.height));
                return {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top
                };
            },
            mapBoundsToCapturePixels: (bounds) => screen.dipToScreenRect(null, bounds)
        });
    }
    return defaultService;
}

export async function captureRegion(bounds: ScreenBounds): Promise<CapturedImage> {
    return (await getDefaultService()).captureRegion(bounds);
}

export async function translateScreenshot(
    bounds: ScreenBounds
): Promise<TranslationTask> {
    return (await getDefaultService()).translateScreenshot(bounds);
}

export function disposeCapturedImage(image: CapturedImage): void {
    releaseCapture(trackedCaptures.get(image));
    defaultService?.forgetCapturedImage(image);
}
