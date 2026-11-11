#!/usr/bin/env node
import { uninstall, options } from './lifecycle.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  const opts = options(process.argv.slice(2));
  uninstall(opts);
  console.log('Removed selected owned integrations and restored unchanged backups where applicable. No application was restarted.');
} catch (error) {
  console.error(`Uninstall failed: ${error.message}`);
  process.exitCode = 1;
}
