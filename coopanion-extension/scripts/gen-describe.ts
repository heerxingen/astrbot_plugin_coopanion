/**
 * Writes describe.json: the tool declarations plus their one-line summaries, the file the extension
 * page and the market read without executing the package.
 *
 *   npm run describe
 *
 * Run it after changing a tool's name, description or parameters; CI fails when the committed
 * describe.json is out of date.
 */
import { writeFileSync } from 'node:fs';
import { CUA_SUMMARIES } from '../src/definition.ts';
import { CHAT_TOOL_SPEC, CUA_TOOL_SPECS } from '../src/world.ts';

const tools = [CHAT_TOOL_SPEC, ...CUA_TOOL_SPECS].map(({ name, description, parameters, tags }) => ({
  name,
  description,
  parameters,
  tags,
  summary: CUA_SUMMARIES[name],
}));

const out = { tools, events: [] };
writeFileSync(new URL('../describe.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('describe.json: ' + tools.length + ' tools');
