/**
 * Writes describe.json: the definition's own self-description (tools with their one-line
 * summaries, and the events it pushes). The extension page and the market read this file
 * without executing the package.
 *
 *   npm run describe
 *
 * Run it after changing a tool, event or prompt; CI fails when the committed file is out of date.
 */
import { writeFileSync } from 'node:fs';
import { CUA } from '../src/definition.ts';

const out = CUA.describe;
if (!out) throw new Error('CUA has no describe block');

writeFileSync(new URL('../describe.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('describe.json: ' + out.tools.length + ' tools, ' + out.events.length + ' events');
