import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function activate(ctx) {
  const { root } = JSON.parse(await readFile(new URL('./bridge-root.json', import.meta.url), 'utf8'));
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Invalid Agent Intercom installation path; run the installer again');
  const modulePath = join(root, 'alma.mjs');
  const { AlmaBridge } = await import(`${pathToFileURL(modulePath).href}?v=${(await stat(modulePath)).mtimeMs}`);
  const { tools, validate } = await import(pathToFileURL(join(root, 'tools.mjs')).href);
  const bridge = new AlmaBridge(ctx.id);
  const hostContexts = new WeakMap();
  const names = new Set(tools.flatMap(tool => [`plugin--${ctx.id}--${tool.name}`, `${ctx.id}.${tool.name}`]));
  const hook = ctx.events.on('tool.willExecute', payload => {
    if (!names.has(payload.tool) || !payload.args || typeof payload.args !== 'object') return;
    // Alma 0.4.567 plugin execute() receives an empty threadId. Its native hook
    // carries the actual AsyncLocalStorage context. Key by this call's args,
    // never by a global 'current thread' or a model-authored identity field.
    hostContexts.set(payload.args, Object.freeze({ ...payload.context }));
  });
  for (const tool of tools) {
    ctx.tools.register(tool.name, {
      description: `${tool.description} [alma-output-safety: exact]`,
      parameters: tool.inputSchema,
      execute: async args => {
        const context = hostContexts.get(args);
        hostContexts.delete(args);
        if (!context) throw new Error('Missing native Alma caller context; refusing to guess the conversation');
        validate(tool, args);
        return bridge.call(tool.name, args, context);
      },
    });
  }
  return {
    async dispose() {
      hook.dispose();
      for (const tool of tools) ctx.tools.unregister(tool.name);
      await bridge.close();
    },
  };
}
