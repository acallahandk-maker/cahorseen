import { workerData } from 'node:worker_threads';

if (workerData.mode === 'hang') {
    setInterval(() => undefined, 1_000);
} else {
    setTimeout(() => {
        throw new Error('synthetic memory worker crash');
    }, 5);
}
