#!/usr/bin/env node
// Thin executable wrapper. The CLI owns exit codes and never rejects.
import { main } from '../obsidian/cli.mjs';

main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`obsidian: io: ${error && error.message ? error.message : 'unexpected failure'}\n`);
    process.exitCode = 1;
  });
