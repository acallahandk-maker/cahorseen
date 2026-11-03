import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'parallel-tests',
                    include: ['tests/**/*.test.{ts,tsx}'],
                    exclude: ['tests/integration/memoryDatabase.test.ts'],
                    sequence: { groupOrder: 1 }
                }
            },
            {
                test: {
                    name: 'memory-worker-tests',
                    include: ['tests/integration/memoryDatabase.test.ts'],
                    pool: 'vmThreads',
                    isolate: false,
                    maxWorkers: 1,
                    sequence: { groupOrder: 2 }
                }
            }
        ]
    }
});
