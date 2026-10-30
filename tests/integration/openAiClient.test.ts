import { describe, expect, it } from 'vitest';
import {
    OpenAiClient,
    ProviderError,
    validateCapturedImageRequest
} from '../../src/main/services/openAiClient';
import {
    MAX_CAPTURED_IMAGE_BYTES,
    type CapturedImage,
    type ProviderConfig
} from '../../src/shared/contracts';

const SYNTHETIC_API_KEY = 'sk-synthetic-test-only-123';
const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: SYNTHETIC_API_KEY,
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    timeoutMs: 1_000
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json',
            'x-api-key': SYNTHETIC_API_KEY
        }
    });
}

function bodyFromInit(init?: RequestInit) {
    return JSON.parse(String(init?.body)) as {
        model: string;
        stream?: boolean;
        messages: Array<{ role: string; content: unknown }>;
    };
}

function delayedBodyResponse(delayMs: number, onCancel: () => void) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            timeout = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({
                    choices: [{ message: { content: 'delayed translation' } }]
                })));
                controller.close();
            }, delayMs);
        },
        cancel() {
            clearTimeout(timeout);
            onCancel();
        }
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function sseResponse(events: unknown[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
    });
}

function capturedImageOfSize(byteLength: number): CapturedImage {
    return {
        dataUrl: `data:image/png;base64,${Buffer.alloc(byteLength).toString('base64')}`,
        mimeType: 'image/png',
        width: 1,
        height: 1,
        byteLength
    };
}

function chunkedBodyResponse(chunks: Uint8Array[], onChunk: () => void) {
    let nextChunk = 0;
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (nextChunk === chunks.length) {
                controller.close();
                return;
            }
            onChunk();
            controller.enqueue(chunks[nextChunk]);
            nextChunk += 1;
        }
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function paddedSseResponse(paddingLength: number) {
    return sseResponse([{
        padding: 'a'.repeat(paddingLength),
        choices: [{ delta: { content: 'ok' } }]
    }]);
}

describe('OpenAI-compatible translation client', () => {
    it('sends text requests to the configured model and returns typed output', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return jsonResponse({
                    choices: [{ message: { content: 'Bonjour' } }]
                });
            }
        });

        const result = await client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        });

        expect(result).toEqual({
            translatedText: 'Bonjour',
            model: 'synthetic-text-model'
        });
        expect(requestBody?.model).toBe('synthetic-text-model');
        expect(requestBody?.messages.some((message) => {
            return message.role === 'user' && String(message.content).includes('hello');
        })).toBe(true);
    });

    it('sends image requests to the separate vision model', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return jsonResponse({
                    choices: [{ message: { content: 'translated image text' } }]
                });
            }
        });

        const result = await client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/png;base64,AA==',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 1
            },
            targetLanguage: 'en'
        });

        expect(result).toEqual({
            translatedText: 'translated image text',
            model: 'synthetic-vision-model'
        });
        expect(requestBody?.model).toBe('synthetic-vision-model');
        expect(requestBody?.messages.some((message) => {
            return JSON.stringify(message.content).includes('data:image/png;base64,AA==');
        })).toBe(true);
    });

    it('extracts safe source and translation text from structured image responses', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return jsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                sourceText: 'Bonjour le monde',
                                translatedText: 'Hello world'
                            })
                        }
                    }]
                });
            }
        });

        const result = await client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/png;base64,AA==',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 1
            },
            targetLanguage: 'en',
            structuredResponse: true
        });

        expect(result).toEqual({
            sourceText: 'Bonjour le monde',
            translatedText: 'Hello world',
            model: 'synthetic-vision-model'
        });
        expect(requestBody?.messages.some((message) => {
            return JSON.stringify(message.content).includes('sourceText');
        })).toBe(true);
    });

    it.each([
        ['data URL', 'data:image/png;base64,AAAA'],
        ['MIME-less data URL', 'data:,AAAA'],
        ['case and whitespace varied data URL', ' DaTa : , AAAA '],
        ['base64 data URL', 'data:;base64,QUJDRA=='],
        ['base64 payload', 'QmFzZTY0UGF5bG9hZEJhc2U2NFBheWxvYWRCYXNlNjRQYXlsb2FkQmFzZTY0UGF5bG9hZA=='],
        ['base64 fragment', 'base64,AAAA'],
        ['capture placeholder', 'Screenshot region:'],
        ['punctuation-wrapped placeholder', '[SCREENSHOT REGION]!'],
        ['redacted capture placeholder', 'Screenshot region (redacted)'],
        [
            'standard base64 wrapped across 16-character chunks',
            'ZGF0YTosQUFBQUFB QUFBQUFBQUFBQUFB QUFBQUFBQUFBQUFB'
        ],
        ['short padded encoded token', 'QUJDRA=='],
        ['long unspaced payload', 'A'.repeat(80)]
    ])('rejects %s before exposing structured image results', async (_kind, sourceText) => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            sourceText,
                            translatedText: 'Hello world'
                        })
                    }
                }]
            })
        });

        await expect(client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/png;base64,AA==',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 1
            },
            targetLanguage: 'en',
            structuredResponse: true
        })).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it.each([
        ['multilingual OCR', 'Café — 你好，¿qué tal?\nLine 2.'],
        ['technical MIME text', 'text/plain, UTF-8'],
        [
            'long natural-language sentence with short words',
            'Please bring the signed application form to the reception desk before Friday morning today.'
        ]
    ])('accepts %s as structured image source text', async (_kind, sourceText) => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            sourceText,
                            translatedText: 'Hello world'
                        })
                    }
                }]
            })
        });

        await expect(client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/png;base64,AA==',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 1
            },
            targetLanguage: 'en',
            structuredResponse: true
        })).resolves.toMatchObject({
            sourceText
        });
    });

    it('streams text deltas and returns the final translation', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const deltas: string[] = [];
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return sseResponse([
                    { choices: [{ delta: { content: 'Bon' } }] },
                    { choices: [{ delta: { content: 'jour' } }] }
                ]);
            }
        });

        const result = await client.translateText({
            provider: { ...provider, streaming: true },
            sourceText: 'hello',
            targetLanguage: 'fr'
        }, undefined, (delta) => {
            deltas.push(delta);
        });

        expect(result).toEqual({
            translatedText: 'Bonjour',
            model: 'synthetic-text-model'
        });
        expect(deltas).toEqual(['Bon', 'jour']);
        expect(requestBody?.stream).toBe(true);
    });

    it('streams image deltas through the vision model', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const deltas: string[] = [];
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return sseResponse([
                    { choices: [{ delta: { content: 'image ' } }] },
                    { choices: [{ delta: { content: 'translation' } }] }
                ]);
            }
        });

        const result = await client.translateImage({
            provider: { ...provider, streaming: true },
            image: {
                dataUrl: 'data:image/png;base64,AA==',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                byteLength: 1
            },
            targetLanguage: 'en'
        }, undefined, (delta) => {
            deltas.push(delta);
        });

        expect(result).toEqual({
            translatedText: 'image translation',
            model: 'synthetic-vision-model'
        });
        expect(deltas).toEqual(['image ', 'translation']);
        expect(requestBody?.model).toBe('synthetic-vision-model');
        expect(requestBody?.stream).toBe(true);
    });

    it('rejects streamed output above the exact limit before accepting the oversized delta', async () => {
        const deltas: string[] = [];
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return sseResponse([
                    { choices: [{ delta: { content: 'a'.repeat(16_001) } }] }
                ]);
            }
        });

        await expect(client.translateText({
            provider: { ...provider, streaming: true },
            sourceText: 'hello',
            targetLanguage: 'fr'
        }, undefined, (delta) => {
            deltas.push(delta);
        })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(deltas).toEqual([]);
        expect(requestBody?.stream).toBe(true);
    });

    it('returns typed errors for malformed streaming responses', async () => {
        let requestBody: ReturnType<typeof bodyFromInit> | undefined;
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => {
                requestBody = bodyFromInit(init);
                return sseResponse([
                    { choices: [{ delta: { content: 42 } }] }
                ]);
            }
        });

        await expect(client.translateText({
            provider: { ...provider, streaming: true },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(requestBody?.stream).toBe(true);
    });

    it('rejects plaintext HTTP endpoints before transmitting the API key', async () => {
        let requestStarted = false;
        const client = new OpenAiClient({
            fetchImpl: async () => {
                requestStarted = true;
                return jsonResponse({
                    choices: [{ message: { content: 'must not be reached' } }]
                });
            }
        });

        await expect(client.translateText({
            provider: {
                ...provider,
                baseUrl: 'http://provider.example/v1'
            },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-config' });
        expect(requestStarted).toBe(false);
    });

    it.each([
        {
            name: 'source text',
            request: {
                sourceText: 'a'.repeat(32_001),
                targetLanguage: 'fr'
            }
        },
        {
            name: 'context',
            request: {
                sourceText: 'hello',
                context: 'a'.repeat(16_001),
                targetLanguage: 'fr'
            }
        },
        {
            name: 'target language',
            request: {
                sourceText: 'hello',
                targetLanguage: 'a'.repeat(65)
            }
        }
    ])('rejects $name above its exact limit', async ({ request }) => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{ message: { content: 'must not be reached' } }]
            })
        });

        await expect(client.translateText({
            provider,
            ...request
        })).rejects.toMatchObject({ code: 'invalid-config' });
    });

    it('rejects system prompts above the exact limit', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{ message: { content: 'must not be reached' } }]
            })
        });

        await expect(client.translateText({
            provider: {
                ...provider,
                systemPrompt: 'a'.repeat(4_001)
            },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-config' });
    });

    it('accepts source, context, system prompt, and target language at their exact limits', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{ message: { content: 'ok' } }]
            })
        });

        await expect(client.translateText({
            provider: {
                ...provider,
                systemPrompt: 'a'.repeat(4_000)
            },
            sourceText: 'a'.repeat(32_000),
            context: 'a'.repeat(16_000),
            targetLanguage: 'a'.repeat(64)
        })).resolves.toEqual({
            translatedText: 'ok',
            model: 'synthetic-text-model'
        });
    });

    it('rejects non-streaming output above the exact limit', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{ message: { content: 'a'.repeat(16_001) } }]
            })
        });

        await expect(client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('keeps timeout active through response-body consumption', async () => {
        let bodyCancelled = false;
        const client = new OpenAiClient({
            fetchImpl: async () => delayedBodyResponse(20, () => {
                bodyCancelled = true;
            })
        });

        await expect(client.translateText({
            provider: { ...provider, timeoutMs: 5 },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'timeout' });
        expect(bodyCancelled).toBe(true);
    });

    it('keeps caller cancellation active through response-body consumption', async () => {
        let bodyCancelled = false;
        const client = new OpenAiClient({
            fetchImpl: async () => delayedBodyResponse(20, () => {
                bodyCancelled = true;
            })
        });
        const controller = new AbortController();
        const request = client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        }, controller.signal);
        setTimeout(() => controller.abort(), 5);

        await expect(request).rejects.toMatchObject({ code: 'aborted' });
        expect(bodyCancelled).toBe(true);
    });

    it.each([
        {
            name: 'empty response',
            response: () => jsonResponse({ choices: [] }),
            code: 'invalid-response'
        },
        {
            name: 'structurally malformed response',
            response: () => jsonResponse({ choices: [null] }),
            code: 'invalid-response'
        },
        {
            name: 'empty translation content',
            response: () => jsonResponse({
                choices: [{ message: { content: '' } }]
            }),
            code: 'invalid-response'
        },
        {
            name: 'malformed response',
            response: () => new Response('<html>not json</html>', {
                status: 200,
                headers: {
                    'content-type': 'text/html',
                    'x-api-key': SYNTHETIC_API_KEY
                }
            }),
            code: 'invalid-response'
        },
        {
            name: 'rate-limited response',
            response: () => jsonResponse({
                error: { message: `secret=${SYNTHETIC_API_KEY}` }
            }, 429),
            code: 'rate-limited'
        }
    ])('returns safe typed errors for $name', async ({ response, code }) => {
        const client = new OpenAiClient({
            fetchImpl: async () => response()
        });

        try {
            await client.translateText({
                provider,
                sourceText: 'hello',
                targetLanguage: 'fr'
            });
            throw new Error('expected provider request to fail');
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError);
            expect((error as ProviderError).code).toBe(code);
            expect(String(error).includes(SYNTHETIC_API_KEY)).toBe(false);
            expect(JSON.stringify(error).includes(SYNTHETIC_API_KEY)).toBe(false);
            expect(JSON.stringify(error).includes('x-api-key')).toBe(false);
        }
    });

    it('returns timeout errors without provider response details', async () => {
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            })
        });

        await expect(client.translateText({
            provider: { ...provider, timeoutMs: 5 },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'timeout' });
    });

    it('cancels requests when the caller aborts', async () => {
        const client = new OpenAiClient({
            fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            })
        });
        const controller = new AbortController();
        const request = client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        }, controller.signal);
        controller.abort();

        await expect(request).rejects.toMatchObject({ code: 'aborted' });
    });

    it('returns typed errors for malformed image input without echoing the image', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => jsonResponse({
                choices: [{ message: { content: 'should not be reached' } }]
            })
        });

        try {
            await client.translateImage({
                provider,
                image: {
                    dataUrl: 'data:image/png;base64,AAAA',
                    mimeType: 'image/png',
                    width: 1,
                    height: 1,
                    byteLength: 1
                },
                targetLanguage: 'en'
            });
            throw new Error('expected image request to fail');
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError);
            expect((error as ProviderError).code).toBe('invalid-config');
            expect(String(error).includes('AAAA')).toBe(false);
        }
    });

    it('accepts captured images at the 8 MiB request boundary', async () => {
        let requestStarted = false;
        const client = new OpenAiClient({
            fetchImpl: async () => {
                requestStarted = true;
                return jsonResponse({
                    choices: [{ message: { content: 'ok' } }]
                });
            }
        });
        const boundaryImage = capturedImageOfSize(MAX_CAPTURED_IMAGE_BYTES);

        expect(() => validateCapturedImageRequest(boundaryImage)).not.toThrow();
        await expect(client.translateImage({
            provider,
            image: boundaryImage,
            targetLanguage: 'en'
        })).resolves.toMatchObject({ translatedText: 'ok' });
        expect(requestStarted).toBe(true);
    });

    it('rejects captured images just over 8 MiB before starting a request', async () => {
        let requestStarted = false;
        const client = new OpenAiClient({
            fetchImpl: async () => {
                requestStarted = true;
                return jsonResponse({
                    choices: [{ message: { content: 'must not be reached' } }]
                });
            }
        });
        const oversizedImage = capturedImageOfSize(MAX_CAPTURED_IMAGE_BYTES + 1);

        expect(() => validateCapturedImageRequest(oversizedImage)).toThrow(ProviderError);
        await expect(client.translateImage({
            provider,
            image: oversizedImage,
            targetLanguage: 'en'
        })).rejects.toMatchObject({ code: 'invalid-config' });
        expect(requestStarted).toBe(false);
    });

    it('rejects delayed non-stream response bodies over 1 MiB before JSON parsing', async () => {
        const encoder = new TextEncoder();
        const oversizedBody = encoder.encode(
            `${' '.repeat(1_048_577)}${JSON.stringify({
                choices: [{ message: { content: 'must not be reached' } }]
            })}`
        );
        const client = new OpenAiClient({
            fetchImpl: async () => new Promise((resolve) => {
                setTimeout(() => {
                    resolve(new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(oversizedBody);
                            controller.close();
                        }
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                    }));
                }, 20);
            })
        });

        await expect(client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('rejects cumulative non-stream response bytes over 1 MiB across chunks', async () => {
        const encoder = new TextEncoder();
        let chunksRead = 0;
        const client = new OpenAiClient({
            fetchImpl: async () => chunkedBodyResponse([
                encoder.encode(' '.repeat(600 * 1024)),
                encoder.encode(`${' '.repeat(600 * 1024)}${JSON.stringify({
                    choices: [{ message: { content: 'must not be reached' } }]
                })}`)
            ], () => {
                chunksRead += 1;
            })
        });

        await expect(client.translateText({
            provider,
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(chunksRead).toBe(2);
    });

    it('accepts streaming SSE raw payloads over 1 MiB when output stays under the semantic limit', async () => {
        const deltas: string[] = [];
        const client = new OpenAiClient({
            fetchImpl: async () => paddedSseResponse(1_200_000)
        });

        const result = await client.translateText({
            provider: { ...provider, streaming: true },
            sourceText: 'hello',
            targetLanguage: 'fr'
        }, undefined, (delta) => {
            deltas.push(delta);
        });

        expect(result).toEqual({
            translatedText: 'ok',
            model: 'synthetic-text-model'
        });
        expect(deltas).toEqual(['ok']);
    });

    it('rejects streaming SSE raw payloads over 2 MiB', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => paddedSseResponse(2_200_000)
        });

        await expect(client.translateText({
            provider: { ...provider, streaming: true },
            sourceText: 'hello',
            targetLanguage: 'fr'
        })).rejects.toMatchObject({ code: 'invalid-response' });
    });
});
