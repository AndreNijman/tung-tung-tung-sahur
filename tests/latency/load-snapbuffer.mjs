// Lifts SnapBuffer (index.html, "remote bodies") out of the page, so the
// latency harness and unit tests run the exact code the game runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../../index.html', import.meta.url));

export function loadSnapBuffer(file = PAGE) {
  const html = readFileSync(file, 'utf8');
  const start = html.indexOf('class SnapBuffer {');
  const end = html.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('SnapBuffer not found in index.html');
  return new Function(`${html.slice(start, end + 2)}\nreturn SnapBuffer;`)();
}
