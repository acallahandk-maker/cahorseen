import { MAX_SOURCE_TEXT_CHARS } from './contracts';

export type VocabularyTextRejectionReason =
    | 'empty'
    | 'too-long'
    | 'control-characters'
    | 'data-url'
    | 'payload-fragment'
    | 'capture-placeholder'
    | 'padded-encoded-token'
    | 'suspicious-encoded-token';

export class VocabularyTextValidationError extends Error {
    readonly reason: VocabularyTextRejectionReason;

    constructor(reason: VocabularyTextRejectionReason) {
        super(`invalid vocabulary source text: ${reason}`);
        this.name = 'VocabularyTextValidationError';
        this.reason = reason;
    }
}

const DATA_URL_FRAGMENT = /\bdata\s*:|\bdata[\s_-]*(?:url|uri)\s*[:=]/iu;
const PAYLOAD_FRAGMENT = /\bbase64\s*[:,=]|\b(?:image|byte)[\s_-]*base64\s*[:=]|\b(?:dataUrl|data_url|byteLength|mimeType|captureBounds|screenshotBounds)\b\s*[:=]|\b(?:image|audio|video|application|text)\/[a-z0-9.+-]+\s*[;,]\s*[a-z0-9+/=_-]{4,}/iu;
const PADDED_ENCODED_TOKEN = /(?<![a-z0-9+/=_-])([a-z0-9+/_-]+)\s*(={1,2})(?![a-z0-9+/=_-])/giu;
const LONG_ENCODED_TOKEN = /[a-z0-9+/_-]{64,}/iu;
const ENCODED_CHUNK = /[a-z0-9+/_-]{4,}={0,2}/giu;
const CAPTURE_PLACEHOLDERS = new Set([
    'screenshot',
    'screenshot region',
    'screenshot capture',
    'screenshot image',
    'captured image',
    'captured screenshot',
    'captured image region',
    'captured region',
    'capture screenshot',
    'capture image',
    'screen capture',
    'image region',
    'capture region',
    'image capture region'
]);

function reject(reason: VocabularyTextRejectionReason): never {
    throw new VocabularyTextValidationError(reason);
}

function isCapturePlaceholder(value: string): boolean {
    const words = value
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    let stripped = words;
    let previous: string;
    do {
        previous = stripped;
        stripped = stripped
            .replace(/^(?:ocr|source|output|result|input|value)(?:\s+(?:text|source))?\s+/u, '')
            .replace(/\s+(?:ocr|text|output|result|input|value|captured|image|screenshot|region|\d+|[a-z]{1,3}\d+)$/u, '');
    } while (stripped !== previous);
    return CAPTURE_PLACEHOLDERS.has(words) || CAPTURE_PLACEHOLDERS.has(stripped);
}

function isCanonicalPaddedBase64(base: string, padding: string): boolean {
    const remainder = base.length % 4;
    return remainder !== 0
        && padding.length === 4 - remainder
        && (base.length + padding.length) % 4 === 0;
}

function hasPaddedEncodedToken(value: string): boolean {
    for (const match of value.matchAll(PADDED_ENCODED_TOKEN)) {
        const base = match[1] ?? '';
        const padding = match[2] ?? '';
        if (isCanonicalPaddedBase64(base, padding))
            return true;
    }
    return false;
}

function hasSuspiciousEncodedPayload(value: string): boolean {
    if (LONG_ENCODED_TOKEN.test(value))
        return true;
    for (const line of value.split(/\r?\n/u)) {
        const chunks = line.match(ENCODED_CHUNK) ?? [];
        const encodedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const hasEncodedShape = chunks.some((chunk) => {
            return /[A-Z]/u.test(chunk) || /[0-9]/u.test(chunk) || chunk.includes('=');
        });
        if (
            chunks.length >= 2
            && chunks.every((chunk) => chunk.length <= 12)
            && encodedLength >= 64
            && hasEncodedShape
        )
            return true;
    }
    return false;
}

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (
            codePoint <= 0x1F && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D
            || codePoint >= 0x7F && codePoint <= 0x9F
        )
            return true;
    }
    return false;
}

export function validateVocabularySourceText(value: string): string {
    const sourceText = value.trim();
    if (sourceText.length === 0)
        reject('empty');
    if (sourceText.length > MAX_SOURCE_TEXT_CHARS)
        reject('too-long');
    if (hasControlCharacters(sourceText))
        reject('control-characters');
    if (DATA_URL_FRAGMENT.test(sourceText))
        reject('data-url');
    if (PAYLOAD_FRAGMENT.test(sourceText))
        reject('payload-fragment');
    if (isCapturePlaceholder(sourceText))
        reject('capture-placeholder');
    if (hasPaddedEncodedToken(sourceText))
        reject('padded-encoded-token');
    if (hasSuspiciousEncodedPayload(sourceText))
        reject('suspicious-encoded-token');
    return sourceText;
}
