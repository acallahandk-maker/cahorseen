import {
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_SYSTEM_PROMPT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    MAX_TRANSLATED_TEXT_CHARS,
    MAX_CAPTURED_IMAGE_BYTES,
    capturedImageSchema,
    providerConfigSchema,
    type CapturedImage,
    type ProviderErrorCode,
    type ProviderConfig
} from '../../shared/contracts';

export {
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_SYSTEM_PROMPT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    MAX_TRANSLATED_TEXT_CHARS
};
export const MIN_PROVIDER_TIMEOUT_MS = 1;
export const MAX_PROVIDER_TIMEOUT_MS = 120_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
export const MAX_NON_STREAMING_RESPONSE_BYTES = 1024 * 1024;
export const MAX_STREAMING_RESPONSE_BYTES = 2 * 1024 * 1024;

const providerErrorMessages: Record<ProviderErrorCode, string> = {
    'invalid-config': 'Provider configuration is invalid.',
    'invalid-response': 'Provider returned an invalid response.',
    authentication: 'Provider authentication failed.',
    'rate-limited': 'Provider rate limit exceeded.',
    timeout: 'Provider request timed out.',
    aborted: 'Provider request was cancelled.',
    network: 'Provider request failed.',
    server: 'Provider service error.',
    'invalid-storage': 'Provider storage is invalid.',
    'provider-not-found': 'Provider is not configured.',
    'storage-unavailable': 'Secure storage is unavailable.',
    'storage-error': 'Provider storage could not be updated.'
};

export function providerErrorMessage(code: ProviderErrorCode): string {
    return providerErrorMessages[code];
}

export class ProviderError extends Error {
    readonly code: ProviderErrorCode;

    constructor(code: ProviderErrorCode) {
        super(providerErrorMessages[code]);
        this.name = 'ProviderError';
        this.code = code;
    }

    toJSON(): { name: string; code: ProviderErrorCode; message: string } {
        return {
            name: this.name,
            code: this.code,
            message: this.message
        };
    }
}

export interface TextTranslationRequest {
    provider: ProviderConfig;
    sourceText: string;
    context?: string;
    targetLanguage: string;
}

export interface ImageTranslationRequest {
    provider: ProviderConfig;
    image: CapturedImage;
    context?: string;
    targetLanguage: string;
}

export interface TranslationResult {
    translatedText: string;
    model: string;
}

export type TranslationDeltaHandler = (delta: string) => void;

export interface OpenAiClientOptions {
    fetchImpl?: typeof fetch;
}

export function validateProviderConfig(provider: ProviderConfig): ProviderConfig {
    const parsed = providerConfigSchema.safeParse(provider);
    if (!parsed.success)
        throw new ProviderError('invalid-config');

    let baseUrl: URL;
    try {
        baseUrl = new URL(parsed.data.baseUrl);
    } catch {
        throw new ProviderError('invalid-config');
    }

    if (
        baseUrl.protocol !== 'https:'
        || baseUrl.username.length > 0
        || baseUrl.password.length > 0
        || baseUrl.search.length > 0
        || baseUrl.hash.length > 0
    )
        throw new ProviderError('invalid-config');

    if (
        parsed.data.timeoutMs !== undefined
        && (
            parsed.data.timeoutMs < MIN_PROVIDER_TIMEOUT_MS
            || parsed.data.timeoutMs > MAX_PROVIDER_TIMEOUT_MS
        )
    )
        throw new ProviderError('invalid-config');

    if (
        parsed.data.systemPrompt !== undefined
        && parsed.data.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
    )
        throw new ProviderError('invalid-config');

    if (
        parsed.data.targetLanguage !== undefined
        && requireBoundedValue(
            parsed.data.targetLanguage,
            MAX_TARGET_LANGUAGE_CHARS
        ) === undefined
    )
        throw new ProviderError('invalid-config');

    return parsed.data;
}

type ChatContent =
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface ChatCompletionBody {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: ChatContent }>;
    temperature: number;
    stream: boolean;
}

function requireBoundedValue(value: unknown, maximumLength: number): string | undefined {
    if (typeof value !== 'string' || value.length > maximumLength)
        return undefined;
    return value;
}

function requireNonEmpty(value: unknown, maximumLength: number): string {
    const bounded = requireBoundedValue(value, maximumLength);
    if (bounded === undefined || bounded.trim().length === 0)
        throw new ProviderError('invalid-config');
    return bounded;
}

function translationInstruction(targetLanguage: string): string {
    return `Translate the following content into ${targetLanguage}. Return only the translation.`;
}

function chatCompletionUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function errorForStatus(status: number): ProviderErrorCode {
    if (status === 401 || status === 403)
        return 'authentication';
    if (status === 408 || status === 504)
        return 'timeout';
    if (status === 429)
        return 'rate-limited';
    return 'server';
}

class RequestAbortedError extends Error {
    constructor() {
        super('Request aborted');
        this.name = 'RequestAbortedError';
    }
}

function abortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    onAbort: () => void
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            onAbort();
            reject(new RequestAbortedError());
        };
        if (signal.aborted) {
            abort();
            return;
        }

        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}

async function readBodyWithAbort(
    response: Response,
    signal: AbortSignal,
    maximumRawBytes: number,
    onChunk?: (chunk: string) => void
): Promise<string> {
    if (response.body === null)
        return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let bodyBytes = 0;
    try {
        while (true) {
            const result = await abortable(reader.read(), signal, () => {
                void reader.cancel().catch(() => undefined);
            });
            if (result.done)
                break;
            bodyBytes += result.value.byteLength;
            if (bodyBytes > maximumRawBytes)
                throw new ProviderError('invalid-response');
            const chunk = decoder.decode(result.value, { stream: true });
            if (onChunk === undefined)
                body += chunk;
            else
                onChunk(chunk);
        }
        const finalChunk = decoder.decode();
        if (onChunk === undefined)
            body += finalChunk;
        else if (finalChunk.length > 0)
            onChunk(finalChunk);
        return body;
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}

async function withRequestSignal<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal) => Promise<T>
): Promise<T> {
    if (signal?.aborted)
        throw new ProviderError('aborted');

    const controller = new AbortController();
    let timedOut = false;
    const cancelRequest = () => controller.abort();
    signal?.addEventListener('abort', cancelRequest, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        return await operation(controller.signal);
    } catch (error) {
        if (error instanceof ProviderError)
            throw error;
        if (timedOut)
            throw new ProviderError('timeout');
        if (signal?.aborted)
            throw new ProviderError('aborted');
        throw new ProviderError('network');
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancelRequest);
    }
}

function parseTranslationResponse(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null)
        throw new ProviderError('invalid-response');

    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0)
        throw new ProviderError('invalid-response');

    const firstChoice: unknown = choices[0];
    if (typeof firstChoice !== 'object' || firstChoice === null)
        throw new ProviderError('invalid-response');

    const message: unknown = (firstChoice as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null)
        throw new ProviderError('invalid-response');

    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string' || content.trim().length === 0)
        throw new ProviderError('invalid-response');
    if (content.length > MAX_TRANSLATED_TEXT_CHARS)
        throw new ProviderError('invalid-response');

    return content;
}

export function validateCapturedImageRequest(image: CapturedImage): CapturedImage {
    let parsed: CapturedImage;
    try {
        parsed = capturedImageSchema.parse(image);
    } catch {
        throw new ProviderError('invalid-config');
    }

    const prefix = `data:${parsed.mimeType};base64,`;
    const decodedByteLength = Buffer.from(
        parsed.dataUrl.slice(prefix.length),
        'base64'
    ).byteLength;
    if (parsed.byteLength > MAX_CAPTURED_IMAGE_BYTES || decodedByteLength > MAX_CAPTURED_IMAGE_BYTES)
        throw new ProviderError('invalid-config');

    return parsed;
}

function parseStreamDelta(payload: unknown): string | undefined {
    if (typeof payload !== 'object' || payload === null)
        throw new ProviderError('invalid-response');

    const choices: unknown = (payload as { choices?: unknown }).choices;
    const usage: unknown = (payload as { usage?: unknown }).usage;
    if (choices === undefined) {
        if (usage !== undefined)
            return undefined;
        throw new ProviderError('invalid-response');
    }
    if (!Array.isArray(choices))
        throw new ProviderError('invalid-response');
    if (choices.length === 0)
        return undefined;

    const firstChoice: unknown = choices[0];
    if (typeof firstChoice !== 'object' || firstChoice === null)
        throw new ProviderError('invalid-response');

    const delta: unknown = (firstChoice as { delta?: unknown }).delta;
    if (delta === undefined)
        return undefined;
    if (typeof delta !== 'object' || delta === null)
        throw new ProviderError('invalid-response');

    const content: unknown = (delta as { content?: unknown }).content;
    if (content === undefined)
        return undefined;
    if (typeof content !== 'string')
        throw new ProviderError('invalid-response');
    return content;
}

async function parseStreamingResponse(
    response: Response,
    signal: AbortSignal,
    onDelta?: TranslationDeltaHandler
): Promise<string> {
    let eventBuffer = '';
    let translatedText = '';
    let completed = false;

    const consumeEvent = (event: string) => {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
        if (data.length === 0)
            return;
        if (data === '[DONE]') {
            completed = true;
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(data);
        } catch {
            throw new ProviderError('invalid-response');
        }

        const delta = parseStreamDelta(payload);
        if (delta === undefined || delta.length === 0)
            return;
        if (translatedText.length + delta.length > MAX_TRANSLATED_TEXT_CHARS)
            throw new ProviderError('invalid-response');

        translatedText += delta;
        onDelta?.(delta);
    };

    await readBodyWithAbort(response, signal, MAX_STREAMING_RESPONSE_BYTES, (chunk) => {
        eventBuffer += chunk;
        const events = eventBuffer.split(/\r?\n\r?\n/);
        eventBuffer = events.pop() ?? '';
        for (const event of events)
            consumeEvent(event);
    });
    if (eventBuffer.length > 0)
        consumeEvent(eventBuffer);

    if (!completed || translatedText.length === 0)
        throw new ProviderError('invalid-response');
    return translatedText;
}

export class OpenAiClient {
    private readonly fetchImpl: typeof fetch;

    constructor(options: OpenAiClientOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async translateText(
        request: TextTranslationRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        const provider = validateProviderConfig(request.provider);
        const sourceText = requireNonEmpty(
            request.sourceText,
            MAX_SOURCE_TEXT_CHARS
        );
        const context = requireBoundedValue(request.context, MAX_CONTEXT_CHARS);
        if (request.context !== undefined && context === undefined)
            throw new ProviderError('invalid-config');
        const targetLanguage = requireNonEmpty(
            request.targetLanguage,
            MAX_TARGET_LANGUAGE_CHARS
        );
        const contextSection = context === undefined
            ? ''
            : `\n\nContext:\n${context}`;
        const messages: ChatCompletionBody['messages'] = [
            {
                role: 'user',
                content: `${translationInstruction(targetLanguage)}\n\n${sourceText}${contextSection}`
            }
        ];

        if (provider.systemPrompt !== undefined)
            messages.unshift({ role: 'system', content: provider.systemPrompt });

        return this.requestTranslation(provider, messages, signal, onDelta);
    }

    async translateImage(
        request: ImageTranslationRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        const provider = validateProviderConfig(request.provider);
        const image = validateCapturedImageRequest(request.image);
        const context = requireBoundedValue(request.context, MAX_CONTEXT_CHARS);
        if (request.context !== undefined && context === undefined)
            throw new ProviderError('invalid-config');
        const targetLanguage = requireNonEmpty(
            request.targetLanguage,
            MAX_TARGET_LANGUAGE_CHARS
        );
        const contextSection = context === undefined
            ? ''
            : `\n\nContext:\n${context}`;
        const messages: ChatCompletionBody['messages'] = [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `${translationInstruction(targetLanguage)}${contextSection}`
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: image.dataUrl
                        }
                    }
                ]
            }
        ];

        if (provider.systemPrompt !== undefined)
            messages.unshift({ role: 'system', content: provider.systemPrompt });

        return this.requestTranslation(provider, messages, signal, onDelta);
    }

    private async requestTranslation(
        provider: ProviderConfig,
        messages: ChatCompletionBody['messages'],
        signal: AbortSignal | undefined,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        const body: ChatCompletionBody = {
            model: '',
            messages,
            temperature: 0.2,
            stream: provider.streaming === true
        };
        const model = messages.some((message) => {
            return Array.isArray(message.content)
                && message.content.some((part) => part.type === 'image_url');
        }) ? provider.visionModel : provider.textModel;
        body.model = model;

        return withRequestSignal(
            provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
            signal,
            async (requestSignal) => {
                const response = await this.fetchImpl(
                    chatCompletionUrl(provider.baseUrl),
                    {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${provider.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body),
                        signal: requestSignal
                    }
                );

                if (!response.ok)
                    throw new ProviderError(errorForStatus(response.status));

                if (body.stream) {
                    return {
                        translatedText: await parseStreamingResponse(
                            response,
                            requestSignal,
                            onDelta
                        ),
                        model
                    };
                }

                let payload: unknown;
                try {
                    payload = JSON.parse(await readBodyWithAbort(
                        response,
                        requestSignal,
                        MAX_NON_STREAMING_RESPONSE_BYTES
                    ));
                } catch (error) {
                    if (error instanceof RequestAbortedError)
                        throw error;
                    throw new ProviderError('invalid-response');
                }

                return {
                    translatedText: parseTranslationResponse(payload),
                    model
                };
            }
        );
    }
}
