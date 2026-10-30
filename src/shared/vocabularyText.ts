import { MAX_SOURCE_TEXT_CHARS } from './contracts';

const DATA_URL = /\bdata\s*:\s*[a-z0-9.+-]+\/[a-z0-9.+-]+(?:\s*;\s*[^,\s]+)*\s*,/iu;
const PAYLOAD_MARKER = /\b(?:base64\s*,|dataUrl|data_url|imageBase64|image_base64|byteLength|mimeType|captureBounds|screenshotBounds)\b/iu;
const CAPTURE_PLACEHOLDER = /^(?:screenshot(?: region| capture| image)?|captured (?:image|screenshot|region)|screen(?:shot)? capture|image region|capture region)$/iu;
const LONG_HEX_TOKEN = /\b[0-9a-f]{128,}\b/iu;
const LONG_ENCODED_TOKEN = /[a-z0-9+/=_-]{64,}/iu;

function hasSuspiciousEncodedShape(token: string): boolean {
    return token.includes('=')
        || /[a-z]/u.test(token)
        && /[A-Z]/u.test(token)
        && /[0-9]/u.test(token);
}

function hasEncodedToken(value: string): boolean {
    for (const token of value.split(/\s+/u)) {
        if (token.length >= 64 && LONG_ENCODED_TOKEN.test(token) && hasSuspiciousEncodedShape(token))
            return true;
    }
    const encodedLines = value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length >= 40 && LONG_ENCODED_TOKEN.test(line));
    return encodedLines.length >= 2
        && encodedLines.join('').length >= 96;
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
    if (
        sourceText.length === 0
        || sourceText.length > MAX_SOURCE_TEXT_CHARS
        || hasControlCharacters(sourceText)
        || DATA_URL.test(sourceText)
        || PAYLOAD_MARKER.test(sourceText)
        || CAPTURE_PLACEHOLDER.test(sourceText)
        || LONG_HEX_TOKEN.test(sourceText)
        || hasEncodedToken(sourceText)
    )
        throw new Error('invalid vocabulary source text');
    return sourceText;
}
