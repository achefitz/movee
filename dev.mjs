// Starts the API (http://localhost:8080) and the Expo app (web on http://localhost:8081;
// press "i"/"a" in its terminal or scan the QR code for a phone).
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['--filter', '@muse/api', 'run', 'dev']],
  ['mobile', ['--filter', '@muse/mobile', 'run', 'dev']],
].map(([name, args]) => {
  const p = spawn('pnpm', args, { stdio: 'inherit', env: process.env });
  p.on('exit', code => {
    console.log(`[${name}] exited with ${code}`);
    for (const q of procs) if (q !== p) q.kill();
    process.exit(code ?? 0);
  });
  return p;
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => procs.forEach(p => p.kill(sig)));
