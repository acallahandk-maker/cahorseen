import {
    capturedImageSchema,
    providerConfigSchema,
    type CapturedImage,
    type ProviderConfig
} from '../../shared/contracts';

export const MIN_PROVIDER_TIMEOUT_MS = 1;
export const MAX_PROVIDER_TIMEOUT_MS = 120_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export type ProviderErrorCode =
    | 'invalid-config'
    | 'invalid-response'
    | 'authentication'
    | 'rate-limited'
    | 'timeout'
    | 'aborted'
    | 'network'
    | 'server';

const providerErrorMessages: Record<ProviderErrorCode, string> = {
    'invalid-config': 'Provider configuration is invalid.',
    'invalid-response': 'Provider returned an invalid response.',
    authentication: 'Provider authentication failed.',
    'rate-limited': 'Provider rate limit exceeded.',
    timeout: 'Provider request timed out.',
    aborted: 'Provider request was cancelled.',
    network: 'Provider request failed.',
    server: 'Provider service error.'
};

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
    targetLanguage: string;
}

export interface ImageTranslationRequest {
    provider: ProviderConfig;
    image: CapturedImage;
    targetLanguage: string;
}

export interface TranslationResult {
    translatedText: string;
    model: string;
}

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
        !['http:', 'https:'].includes(baseUrl.protocol)
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

    return parsed.data;
}

type ChatContent =
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface ChatCompletionBody {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: ChatContent }>;
    temperature: number;
}

function requireNonEmpty(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new ProviderError('invalid-config');
    return value;
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

async function fetchWithTimeout(
    fetchImpl: typeof fetch,
    input: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<Response> {
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
        return await fetchImpl(input, {
            ...init,
            signal: controller.signal
        });
    } catch {
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

    return content;
}

export class OpenAiClient {
    private readonly fetchImpl: typeof fetch;

    constructor(options: OpenAiClientOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async translateText(
        request: TextTranslationRequest,
        signal?: AbortSignal
    ): Promise<TranslationResult> {
        const provider = validateProviderConfig(request.provider);
        const sourceText = requireNonEmpty(request.sourceText);
        const targetLanguage = requireNonEmpty(request.targetLanguage);
        const messages: ChatCompletionBody['messages'] = [
            {
                role: 'user',
                content: `${translationInstruction(targetLanguage)}\n\n${sourceText}`
            }
        ];

        if (provider.systemPrompt !== undefined)
            messages.unshift({ role: 'system', content: provider.systemPrompt });

        return this.requestTranslation(provider, messages, signal);
    }

    async translateImage(
        request: ImageTranslationRequest,
        signal?: AbortSignal
    ): Promise<TranslationResult> {
        const provider = validateProviderConfig(request.provider);
        let image: CapturedImage;
        try {
            image = capturedImageSchema.parse(request.image);
        } catch {
            throw new ProviderError('invalid-config');
        }
        const targetLanguage = requireNonEmpty(request.targetLanguage);
        const messages: ChatCompletionBody['messages'] = [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: translationInstruction(targetLanguage)
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

        return this.requestTranslation(provider, messages, signal);
    }

    private async requestTranslation(
        provider: ProviderConfig,
        messages: ChatCompletionBody['messages'],
        signal?: AbortSignal
    ): Promise<TranslationResult> {
        const body: ChatCompletionBody = {
            model: '',
            messages,
            temperature: 0.2
        };
        const model = messages.some((message) => {
            return Array.isArray(message.content)
                && message.content.some((part) => part.type === 'image_url');
        }) ? provider.visionModel : provider.textModel;
        body.model = model;

        const response = await fetchWithTimeout(
            this.fetchImpl,
            chatCompletionUrl(provider.baseUrl),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${provider.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            },
            provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
            signal
        );

        if (!response.ok)
            throw new ProviderError(errorForStatus(response.status));

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            throw new ProviderError('invalid-response');
        }

        return {
            translatedText: parseTranslationResponse(payload),
            model
        };
    }
}
