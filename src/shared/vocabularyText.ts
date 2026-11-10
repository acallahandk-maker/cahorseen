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

const DATA_URL_FORM = /\bdata\s*:|\bdata[\s_-]*(?:url|uri)\s*[:=]/iu;
const EXPLICIT_BASE64_PAYLOAD = /(?:^|[\s;([{,])(?:[a-z0-9_-]+[\s_-])?base64\s*[:,=]\s*[a-z0-9+/_-]{4,}={0,2}(?=$|[\s;.,!?)\]}])/iu;
const CAPTURE_PAYLOAD_FORM = /\bdata[\s_-]*(?:url|uri)\s*[:=]|\b(?:capture[\s_-]*bounds|screenshot[\s_-]*bounds|image[\s_-]*base64|byte[\s_-]*length)\s*[:=]/iu;
const PADDED_ENCODED_TOKEN = /(?<![a-z0-9+/=_-])([a-z0-9+/_-]+)\s*(={1,2})(?![a-z0-9+/=_-])/giu;
const LONG_ENCODED_TOKEN = /(?<![a-z0-9+/=_-])[a-z0-9+/_-]{32,}={0,2}(?![a-z0-9+/=_-])/giu;
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
const CAPTURE_PLACEHOLDER_VARIANTS = new Set([
    'screenshot region captured',
    'screenshot region redacted',
    'screenshot region unavailable',
    'screenshot region not available',
    'screenshot region omitted',
    'captured image redacted',
    'captured image unavailable'
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
    const withoutLabel = words.replace(
        /^(?:ocr|source|output|result|input|value)(?:\s+(?:text|source))?\s+/u,
        ''
    );
    return CAPTURE_PLACEHOLDERS.has(words)
        || CAPTURE_PLACEHOLDERS.has(withoutLabel)
        || CAPTURE_PLACEHOLDER_VARIANTS.has(words)
        || /^screenshot region(?: \d{1,4})?$/u.test(words);
}

function hasSuspiciousSingleEncodedToken(value: string): boolean {
    const candidate = value.trim();
    if (!/^[a-z0-9+/_-]{32,}={0,2}$/iu.test(candidate))
        return false;
    const bytes = decodeBase64(candidate);
    if (bytes === undefined)
        return false;
    return !decodeText(bytes).valid;
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

function decodeBase64(value: string): Uint8Array | undefined {
    const compact = value.replace(/\s+/gu, '');
    if (compact.length === 0 || compact.length % 4 === 1)
        return undefined;
    const normalized = compact.replace(/-/gu, '+').replace(/_/gu, '/');
    const unpadded = normalized.replace(/=+$/u, '');
    if (!/^[a-z0-9+/]*={0,2}$/iu.test(normalized))
        return undefined;
    const paddingLength = normalized.length - unpadded.length;
    const expectedPadding = (4 - unpadded.length % 4) % 4;
    if (paddingLength !== 0 && paddingLength !== expectedPadding)
        return undefined;

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes: number[] = [];
    let accumulator = 0;
    let bitCount = 0;
    for (const character of unpadded) {
        const index = alphabet.indexOf(character);
        if (index < 0)
            return undefined;
        accumulator = ((accumulator << 6) | index) & 0xFFF;
        bitCount += 6;
        if (bitCount >= 8) {
            bitCount -= 8;
            bytes.push((accumulator >> bitCount) & 0xFF);
            accumulator &= (1 << bitCount) - 1;
        }
    }
    return Uint8Array.from(bytes);
}

function decodeText(bytes: Uint8Array): { text: string; valid: boolean } {
    try {
        return {
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            valid: true
        };
    } catch {
        return {
            text: new TextDecoder('utf-8').decode(bytes),
            valid: false
        };
    }
}

function isBinaryPayload(bytes: Uint8Array, text: string, validUtf8: boolean): boolean {
    const signatures = [
        [0x89, 0x50, 0x4E, 0x47],
        [0xFF, 0xD8, 0xFF],
        [0x47, 0x49, 0x46, 0x38],
        [0x25, 0x50, 0x44, 0x46],
        [0x50, 0x4B, 0x03, 0x04],
        [0x52, 0x49, 0x46, 0x46]
    ];
    if (signatures.some((signature) => signature.every((byte, index) => bytes[index] === byte)))
        return true;

    let controlCount = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0x1F && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D
            || codePoint >= 0x7F && codePoint <= 0x9F)
            controlCount += 1;
    }
    const byteLength = Math.max(bytes.length, 1);
    return controlCount / byteLength >= 0.05
        || !validUtf8 && controlCount >= 2;
}

function isWrappedBase64(tokens: string[]): boolean {
    if (tokens.length < 3)
        return false;
    const chunks = tokens.map((token) => token.replace(/=+$/u, ''));
    const width = chunks[0]?.length ?? 0;
    if (width < 4 || width > 76)
        return false;
    if (chunks.reduce((total, chunk) => total + chunk.length, 0) < 32)
        return false;
    if (chunks.slice(0, -1).some((chunk) => chunk.length !== width))
        return false;
    const finalChunk = chunks.at(-1) ?? '';
    if (finalChunk.length > width || finalChunk.length === 1)
        return false;
    const usesStandardAlphabet = tokens.every((token) => !token.includes('-') && !token.includes('_'));
    const usesUrlSafeAlphabet = tokens.every((token) => !token.includes('+') && !token.includes('/'));
    return usesStandardAlphabet || usesUrlSafeAlphabet;
}

function encodedCandidates(value: string): string[] {
    const candidates = [...value.matchAll(LONG_ENCODED_TOKEN)].map((match) => match[0]);
    for (const line of value.split(/\r?\n/u)) {
        const tokens = line.trim().split(/\s+/u);
        if (isWrappedBase64(tokens))
            candidates.push(tokens.join(''));
    }
    return [...new Set(candidates)];
}

function hasEncodedPayload(value: string): boolean {
    for (const candidate of encodedCandidates(value)) {
        const bytes = decodeBase64(candidate);
        if (bytes === undefined)
            continue;
        const decoded = decodeText(bytes);
        if (
            DATA_URL_FORM.test(decoded.text)
            || CAPTURE_PAYLOAD_FORM.test(decoded.text)
            || isCapturePlaceholder(decoded.text)
            || isBinaryPayload(bytes, decoded.text, decoded.valid)
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
    if (DATA_URL_FORM.test(sourceText))
        reject('data-url');
    if (EXPLICIT_BASE64_PAYLOAD.test(sourceText))
        reject('payload-fragment');
    if (isCapturePlaceholder(sourceText))
        reject('capture-placeholder');
    if (hasPaddedEncodedToken(sourceText))
        reject('padded-encoded-token');
    if (hasSuspiciousSingleEncodedToken(sourceText))
        reject('suspicious-encoded-token');
    if (hasEncodedPayload(sourceText))
        reject('suspicious-encoded-token');
    return sourceText;
}
