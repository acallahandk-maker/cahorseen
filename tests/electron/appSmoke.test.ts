import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { runElectronSmoke } from './harness';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

it('starts_without_node_exposure', async () => {
    const result = await runElectronSmoke('app-smoke');

    expect(result).toEqual({
        scenario: 'app-smoke',
        payload: {
            ping: {
                version: '0.1.0'
            },
            requireIsUndefined: true,
            processIsUndefined: true
        },
        windowCount: 1,
        url: pathToFileURL(path.join(projectRoot, 'out', 'renderer', 'index.html')).href
    });
}, 30_000);
