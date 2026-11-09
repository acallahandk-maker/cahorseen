import {
    mkdtempSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    findPersistedScreenshotFiles,
    parseProcessRows
} from './harness';

describe('electron cleanup diagnostics', () => {
    it('detects image signatures regardless of file extension', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'desktop-pet-image-scan-'));
        writeFileSync(path.join(root, 'capture.bin'), Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
        ]));

        expect(findPersistedScreenshotFiles([root])).toEqual([
            path.join(root, 'capture.bin')
        ]);
    });

    it('fails when a cleanup scan root cannot be read', () => {
        expect(() => findPersistedScreenshotFiles([
            path.join(tmpdir(), 'desktop-pet-missing-scan-root')
        ])).toThrow(/screenshot persistence scan failed/i);
    });

    it('fails closed on process snapshot command or parse errors', () => {
        expect(() => parseProcessRows({
            status: 1,
            stdout: '[]'
        }, 42)).toThrow(/process snapshot failed/i);
        expect(() => parseProcessRows({
            status: 0,
            stdout: ''
        }, 42)).toThrow(/process snapshot failed/i);
    });
});
