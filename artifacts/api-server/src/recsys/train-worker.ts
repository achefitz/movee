import { parentPort, workerData } from 'node:worker_threads';
import { trainRanker, type TrainingRow } from './ranker';

// Built as a separate esbuild entry (dist/train-worker.mjs); see build.mjs.
const { rows } = workerData as { rows: TrainingRow[] };
parentPort?.postMessage(trainRanker(rows));
