// `bun run worker` — the worker alone, no HTTP server. index.ts starts the
// same loop in-process unless WORKER=off; this is for running it as its own
// process instead. See docs/phases/1-map.md "Upload as a worker".
import '../env.ts';
import { startWorker } from './index.ts';

console.log('digsite worker starting (bounded batches; idle poll 500ms)');
startWorker();
