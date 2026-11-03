import { spawnSync } from 'node:child_process';

const forwarded = process.argv.slice(2);
const memoryPath = 'tests/integration/memoryDatabase.test.ts';

function runVitest(args) {
    const result = spawnSync(process.execPath, [
        'node_modules/vitest/vitest.mjs',
        'run',
        ...args
    ], {
        stdio: 'inherit'
    });
    if (result.status !== 0)
        process.exit(result.status ?? 1);
}

if (forwarded.length === 0) {
    runVitest(['--project', 'memory-worker-tests']);
    runVitest(['--exclude', memoryPath]);
    process.exit(0);
}

const memoryArgs = forwarded.filter((argument) => argument.includes(memoryPath));
const parallelArgs = forwarded.filter((argument) => !argument.includes(memoryPath));
if (memoryArgs.length > 0)
    runVitest(['--project', 'memory-worker-tests', ...memoryArgs]);
if (parallelArgs.length > 0)
    runVitest([...parallelArgs, '--exclude', memoryPath]);
