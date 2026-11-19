#!/usr/bin/env node
import { main } from '../src/cli.js';

// A reader that stops early (e.g. `| head`) is not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

main(process.argv.slice(2)).catch((err) => {
  process.stdout.write(`status: error\nerror: ${JSON.stringify(String(err?.message || err))}\n`);
  process.exit(1);
});
