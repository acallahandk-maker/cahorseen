import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    detectSourceLanguage,
    type ProviderConfig,
    type SelectionCapture,
    type SelectionErrorCode,
    type TranslationErrorCode,
    type TranslationTask
} from '../../shared/contracts';
import {
    ProviderError,
    providerErrorMessage,
    type TextTranslationRequest,
    type TranslationDeltaHandler
} from './openAiClient';
import {
    TranslationWorkerRunner,
    type TranslationRunner
} from '../workers/translationWorker';
import { getActiveProviderConfig } from './secureConfig';

export type { TranslationRunner };

export interface SelectionCaptureAdapter {
    readAccessibilitySelection(signal?: AbortSignal): Promise<string>;
    copySelectionToClipboard(signal?: AbortSignal): Promise<void>;
    readClipboardText(signal?: AbortSignal): Promise<string>;
    saveClipboard(): Promise<unknown>;
    restoreClipboard(snapshot: unknown): Promise<void>;
}

export interface SelectionServiceOptions {
    captureAdapter: SelectionCaptureAdapter;
    translationRunner: TranslationRunner;
    getProvider(): Promise<ProviderConfig>;
    createId?: () => string;
}

export interface SelectionTranslationOptions {
    taskId?: string;
    signal?: AbortSignal;
    sourceText?: string;
    targetLanguage?: string;
    context?: string;
    onTaskId?: (taskId: string) => void;
    onDelta?: TranslationDeltaHandler;
}

export class SelectionError extends Error {
    readonly code: SelectionErrorCode | 'aborted' | 'invalid-selection';

    constructor(code: SelectionErrorCode | 'aborted' | 'invalid-selection') {
        super(selectionErrorMessage(code));
        this.name = 'SelectionError';
        this.code = code;
    }
}

function selectionErrorMessage(code: SelectionError['code']): string {
    switch (code) {
        case 'empty-selection':
            return 'No selected text was found.';
        case 'clipboard-read':
            return 'Selected text could not be read.';
        case 'clipboard-restore':
            return 'The original clipboard could not be restored.';
        case 'aborted':
            return 'Selection capture was cancelled.';
        case 'invalid-selection':
            return 'Selected text is too large.';
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (
        error.name === 'AbortError'
        || (error as Error & { code?: unknown }).code === 'ABORT_ERR'
    );
}

function normalizeSelection(value: string): string {
    const sourceText = value.trim();
    if (sourceText.length === 0)
        throw new SelectionError('empty-selection');
    if (sourceText.length > MAX_SOURCE_TEXT_CHARS)
        throw new SelectionError('invalid-selection');
    return sourceText;
}

function safeTaskErrorCode(error: unknown): TranslationErrorCode {
    if (error instanceof ProviderError)
        return error.code;
    if (error instanceof SelectionError)
        return error.code;
    return 'request-failed';
}

function safeTaskError(error: unknown): string {
    const code = safeTaskErrorCode(error);
    if (code === 'request-failed')
        return 'Provider request failed.';
    if (code === 'unsupported-vision')
        return 'Vision translation is not supported. Choose a vision-capable model.';
    if (code === 'empty-selection')
        return 'No selected text was found.';
    if (code === 'clipboard-read')
        return 'Selected text could not be read.';
    if (code === 'clipboard-restore')
        return 'The original clipboard could not be restored.';
    if (code === 'invalid-selection')
        return 'Selected text is too large.';
    if (code === 'unauthorized')
        return 'IPC sender is not authorized.';
    if (code === 'invalid-request')
        return 'Request is invalid.';
    return providerErrorMessage(code);
}

export class SelectionService {
    private readonly captureAdapter: SelectionCaptureAdapter;
    private readonly translationRunner: TranslationRunner;
    private readonly getProvider: () => Promise<ProviderConfig>;
    private readonly createId: () => string;

    constructor(options: SelectionServiceOptions) {
        this.captureAdapter = options.captureAdapter;
        this.translationRunner = options.translationRunner;
        this.getProvider = options.getProvider;
        this.createId = options.createId ?? randomUUID;
    }

    async captureSelectionOnce(signal?: AbortSignal): Promise<SelectionCapture> {
        if (signal?.aborted === true)
            throw new SelectionError('aborted');

        try {
            const sourceText = normalizeSelection(
                await this.captureAdapter.readAccessibilitySelection(signal)
            );
            return {
                sourceText,
                method: 'accessibility',
                clipboardRestored: true
            };
        } catch (error) {
            if (error instanceof SelectionError && error.code === 'invalid-selection')
                throw error;
            if (isAbortError(error) || (signal !== undefined && signal.aborted))
                throw new SelectionError('aborted');
        }

        return this.captureWithClipboard(signal);
    }

    async translateSelection(
        options: SelectionTranslationOptions = {}
    ): Promise<TranslationTask> {
        const taskId = options.taskId ?? this.createId();
        options.onTaskId?.(taskId);

        let sourceText: string;
        try {
            sourceText = options.sourceText === undefined
                ? (await this.captureSelectionOnce(options.signal)).sourceText
                : normalizeSelection(options.sourceText);
        } catch (error) {
            if (error instanceof SelectionError && error.code !== 'aborted')
                throw error;
            throw new SelectionError('aborted');
        }

        let targetLanguage = 'und';
        let provider: ProviderConfig | undefined;
        try {
            provider = await this.getProvider();
            const requestedLanguage = options.targetLanguage
                ?? provider.targetLanguage
                ?? '';
            if (
                requestedLanguage.length === 0
                || requestedLanguage.length > MAX_TARGET_LANGUAGE_CHARS
                || (options.context?.length ?? 0) > MAX_CONTEXT_CHARS
            )
                throw new ProviderError('invalid-config');
            targetLanguage = requestedLanguage;

            const request: TextTranslationRequest & { taskId: string } = {
                taskId,
                provider: {
                    ...provider,
                    streaming: true
                },
                sourceText,
                context: options.context,
                targetLanguage
            };
            const result = await this.translationRunner.run(
                request,
                options.signal,
                options.onDelta
            );
            return {
                id: taskId,
                status: 'completed',
                kind: 'selection',
                sourceText,
                translatedText: result.translatedText,
                sourceLanguage: detectSourceLanguage(sourceText),
                targetLanguage,
                ...(provider.id === undefined ? {} : { providerId: provider.id }),
                providerName: provider.name,
                textModel: provider.textModel,
                visionModel: provider.visionModel,
                translationModel: result.model
            };
        } catch (error) {
            return {
                id: taskId,
                status: 'failed',
                kind: 'selection',
                sourceText,
                translatedText: '',
                sourceLanguage: detectSourceLanguage(sourceText),
                targetLanguage,
                ...(provider?.id === undefined ? {} : { providerId: provider.id }),
                ...(provider === undefined ? {} : {
                    providerName: provider.name,
                    textModel: provider.textModel,
                    visionModel: provider.visionModel
                }),
                error: safeTaskError(error),
                errorCode: safeTaskErrorCode(error)
            };
        }
    }

    private async captureWithClipboard(signal?: AbortSignal): Promise<SelectionCapture> {
        let snapshot: unknown;
        try {
            snapshot = await this.captureAdapter.saveClipboard();
        } catch {
            throw new SelectionError('clipboard-read');
        }

        let capture: SelectionCapture | undefined;
        let captureError: unknown;
        try {
            await this.captureAdapter.copySelectionToClipboard(signal);
            capture = {
                sourceText: normalizeSelection(await this.captureAdapter.readClipboardText(signal)),
                method: 'clipboard',
                clipboardRestored: true
            };
        } catch (error) {
            captureError = error;
        }

        try {
            await this.captureAdapter.restoreClipboard(snapshot);
        } catch {
            throw new SelectionError('clipboard-restore');
        }

        if (capture !== undefined)
            return capture;
        if (isAbortError(captureError) || signal?.aborted === true)
            throw new SelectionError('aborted');
        if (captureError instanceof SelectionError)
            throw captureError;
        throw new SelectionError('clipboard-read');
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

function createWindowsCaptureAdapter(): SelectionCaptureAdapter {
    return {
        readAccessibilitySelection: async (signal) => {
            if (process.platform !== 'win32')
                return '';
            const script = [
                'try {',
                '  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
                '  $element = [System.Windows.Automation.AutomationElement]::FocusedElement',
                '  $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)',
                '  $text = (($pattern.GetSelection() | ForEach-Object { $_.GetText(-1) }) -join "")',
                '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))',
                '} catch { "" }'
            ].join('\n');
            const encoded = (await runPowerShell(script, signal)).trim();
            return encoded.length === 0
                ? ''
                : Buffer.from(encoded, 'base64').toString('utf8');
        },
        copySelectionToClipboard: async (signal) => {
            if (process.platform !== 'win32')
                throw new Error('Clipboard fallback requires Windows.');
            await runPowerShell([
                'Add-Type -AssemblyName System.Windows.Forms',
                '[System.Windows.Forms.SendKeys]::SendWait("^c")',
                'Start-Sleep -Milliseconds 75'
            ].join('\n'), signal);
        },
        readClipboardText: async () => {
            const { clipboard } = await import('electron');
            return clipboard.readText();
        },
        saveClipboard: async () => {
            const { clipboard } = await import('electron');
            return clipboard.read();
        },
        restoreClipboard: async (snapshot) => {
            const { clipboard } = await import('electron');
            const items = snapshot as Parameters<typeof clipboard.write>[0];
            if (items.length === 0)
                clipboard.clear();
            else
                await clipboard.write(items);
        }
    };
}

let defaultService: SelectionService | undefined;

async function getDefaultService(): Promise<SelectionService> {
    defaultService ??= new SelectionService({
        captureAdapter: createWindowsCaptureAdapter(),
        translationRunner: new TranslationWorkerRunner({
            workerPath: join(__dirname, 'translationWorker.js')
        }),
        getProvider: getActiveProviderConfig
    });
    return defaultService;
}

export async function captureSelectionOnce(signal?: AbortSignal): Promise<SelectionCapture> {
    return (await getDefaultService()).captureSelectionOnce(signal);
}

export async function translateSelection(
    options?: SelectionTranslationOptions
): Promise<TranslationTask> {
    return (await getDefaultService()).translateSelection(options);
}
