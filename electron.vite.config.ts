import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: resolve(projectRoot, 'src/main/index.ts')
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
