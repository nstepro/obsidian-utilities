// Standalone stub process: prints "PORT=<n>" then serves. Run directly:
//   node smoke/gcs-stub-proc.mjs
import { startGcsStub } from './gcs-stub.mjs';

const stub = await startGcsStub();
console.log(`PORT=${stub.port}`);
process.on('SIGTERM', () => { stub.close().then(() => process.exit(0)); });
process.on('message', (m) => { if (m === 'close') { stub.close().then(() => process.exit(0)); } });
