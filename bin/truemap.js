#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  process.stdout.write(`status: error\nerror: ${JSON.stringify(String(err?.message || err))}\n`);
  process.exit(1);
});
