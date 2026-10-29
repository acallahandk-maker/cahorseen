import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            'out/**',
            'src/renderer/public/live2d/**'
        ]
    },
    {
        files: ['**/*.{js,mjs,cjs,ts,tsx}'],
        extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module'
        }
    },
    {
        files: ['src/renderer/**/*.{ts,tsx}'],
        languageOptions: {
            globals: globals.browser
        }
    },
    {
        files: ['electron.vite.config.ts', 'src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            globals: globals.node
        }
    }
);
