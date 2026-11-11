#!/usr/bin/env node
import { install, options } from './lifecycle.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  const opts = options(process.argv.slice(2));
  install(opts);
  console.log(`Installed ${opts.targets.join(' + ')}. Reload the relevant MCP connection/plugin yourself, then join each conversation again. No application was restarted.`);
} catch (error) {
  console.error(`Install failed: ${error.message}`);
  process.exitCode = 1;
}
