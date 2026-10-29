import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: {
                    index: resolve(projectRoot, 'src/main/index.ts'),
                    translationWorker: resolve(
                        projectRoot,
                        'src/main/workers/translationWorker.ts'
                    ),
                    memoryWorker: resolve(
                        projectRoot,
                        'src/main/workers/memoryWorker.ts'
                    )
                }
            }
        }
    },
    preload: {
        build: {
            externalizeDeps: false,
            isolatedEntries: true,
            rollupOptions: {
                input: resolve(projectRoot, 'src/preload/index.ts')
            }
        }
    },
    renderer: {
        root: resolve(projectRoot, 'src/renderer'),
        plugins: [react()]
    }
});
