import { describe, expect, it } from 'vitest';
import { validateVocabularySourceText } from '../../src/shared/vocabularyText';

const invalidTextCases = [
    ['MIME-less data URL', 'data:,AAAA', 'data-url'],
    ['case and whitespace varied data URL', ' DaTa : , AAAA ', 'data-url'],
    ['punctuation-wrapped data URL', '(data:,QUJDRA==).', 'data-url'],
    ['MIME-bearing data URL', 'data:text/plain;charset=utf-8,SGVsbG8=', 'data-url'],
    ['base64 data URL', 'data:;base64,QUJDRA==', 'data-url'],
    ['base64 fragment', 'base64,AAAA', 'payload-fragment'],
    ['semicolon base64 fragment', ';base64,QUJDRA==', 'payload-fragment'],
    ['MIME base64 fragment', 'image/png;base64,QUJDRA==', 'payload-fragment'],
    ['data URL property fragment', 'dataUrl:AAAA', 'data-url'],
    ['image base64 property fragment', 'image_base64=QUJDRA==', 'payload-fragment'],
    ['capture placeholder', 'Screenshot region:', 'capture-placeholder'],
    ['case and punctuation varied placeholder', '[SCREENSHOT REGION]!', 'capture-placeholder'],
    ['hyphenated placeholder', 'screenshot-region', 'capture-placeholder'],
    ['labelled placeholder', 'OCR: Screenshot region', 'capture-placeholder'],
    ['affixed placeholder', 'Screenshot region (captured)', 'capture-placeholder'],
    ['metadata-suffixed placeholder', 'Screenshot region 2026:', 'capture-placeholder'],
    ['redacted placeholder', 'Screenshot region (redacted)', 'capture-placeholder'],
    [
        'case and whitespace varied placeholder with arbitrary suffix',
        ' ScReEnShOt ---\tReGiOn ... redacted ',
        'capture-placeholder'
    ],
    ['short padded encoded token', 'QUJDRA==', 'padded-encoded-token'],
    ['punctuation-wrapped padded token', '“QUJDRA==”,', 'padded-encoded-token'],
    ['whitespace-padded encoded token', 'QUJDRA ==', 'padded-encoded-token'],
    ['short URL-safe padded token', 'SGVsbG8=', 'padded-encoded-token'],
    ['control payload blob', 'AAAA\u0000QUJDRA==', 'control-characters'],
    ['long unspaced payload', 'A'.repeat(80), 'suspicious-encoded-token'],
    ['lowercase long unspaced payload', 'q'.repeat(80), 'suspicious-encoded-token'],
    [
        'standard base64 wrapped across 16-character chunks',
        'ZGF0YTosQUFBQUFB QUFBQUFBQUFBQUFB QUFBQUFBQUFBQUFB',
        'suspicious-encoded-token'
    ],
    [
        'capture placeholder encoded across 16-character chunks',
        'U2NyZWVuc2hvdCBy ZWdpb24gKHJlZGFj dGVkKSAgICAgICAg',
        'suspicious-encoded-token'
    ],
    [
        'capture JSON encoded across standard chunks',
        'eyJkYXRhVXJsIjoi ZGF0YTppbWFnZS9w bmc7YmFzZTY0LEFB QUEiLCJtaW1lVHlw ZSI6ImltYWdlL3Bu ZyIsImJ5dGVMZW5n dGgiOjF9',
        'suspicious-encoded-token'
    ],
    [
        'encoded PNG binary payload',
        'iVBORw0KGgoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'suspicious-encoded-token'
    ],
    [
        'whitespace-separated encoded payload',
        'QUJD REFA IHJL MNOP QRST UVWX YZ01 2345 6789 ABCD EFGH IJKL MNOP QRST UVWX YZ01 2345 6789',
        'suspicious-encoded-token'
    ]
] as const;

const validTextCases = [
    ['multilingual OCR', 'Café — 你好，¿qué tal?\nLine 2.'],
    ['ordinary punctuation', 'Hello, world! The total is 2026.'],
    ['technical MIME text', 'text/plain, UTF-8'],
    ['technical MIME list', 'text/plain, application/json; charset=UTF-8, image/png'],
    ['short alphanumeric word', 'OK'],
    ['short mixed alphanumeric word', 'B2B'],
    ['normal product code', 'ABC-123'],
    ['longer product code', 'SKU-12345'],
    ['model number', 'iPhone17 Pro / X200'],
    ['ordinary screenshot sentence', 'The screenshot region contains a blue sign.'],
    ['ordinary encoding name', 'Base64 is an encoding name.'],
    [
        'long natural-language sentence with short words',
        'Please bring the signed application form to the reception desk before Friday morning today.'
    ],
    ['multilingual product label', '版本 v2.0（型号 X200）']
] as const;

describe('vocabulary source text validation', () => {
    it.each(invalidTextCases.map(([name, sourceText, reason]) => ({
        name,
        sourceText,
        reason
    })))(
        'rejects $name with reason $reason',
        ({ sourceText, reason }) => {
            let rejection: unknown;
            try {
                validateVocabularySourceText(sourceText);
            } catch (error) {
                rejection = error;
            }

            expect(rejection).toBeInstanceOf(Error);
            expect(rejection).toMatchObject({ reason });
        }
    );

    it.each(validTextCases)('accepts %s', (_name, sourceText) => {
        expect(validateVocabularySourceText(sourceText)).toBe(sourceText.trim());
    });

    it('rejects empty text and oversized text with explicit bounds reasons', () => {
        expect(() => validateVocabularySourceText('   ')).toThrow(
            expect.objectContaining({ reason: 'empty' })
        );
        expect(() => validateVocabularySourceText('A'.repeat(32_001))).toThrow(
            expect.objectContaining({ reason: 'too-long' })
        );
    });
});
