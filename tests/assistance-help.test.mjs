import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { helpPlacement } from '../src/assistance-help.js';

test('help preview normally sits below its trigger without covering it', () => {
  assert.deepEqual(helpPlacement({ left: 300, top: 60, bottom: 84 }, { width: 420, height: 500 }, { width: 1366, height: 768 }),
    { left: 300, top: 90, maxHeight: 670 });
});
test('help preview moves left at the viewport edge', () => {
  const p = helpPlacement({ left: 1320, top: 60, bottom: 84 }, { width: 420, height: 500 }, { width: 1366, height: 768 });
  assert.equal(p.left, 938); assert.equal(p.top, 90);
});
test('help preview flips above a low trigger', () => {
  const p = helpPlacement({ left: 300, top: 650, bottom: 674 }, { width: 420, height: 500 }, { width: 1366, height: 768 });
  assert.equal(p.top, 144); assert.equal(p.maxHeight, 636);
});
test('help preview uses a scrollable bounded area in short and narrow viewports', () => {
  for (const viewport of [{ width: 320, height: 740 }, { width: 320, height: 320 }, { width: 640, height: 360 }]) {
    const anchor = { left: viewport.width - 32, top: 150, bottom: 174 }, size = { width: Math.min(420, viewport.width - 16), height: 550 };
    const p = helpPlacement(anchor, size, viewport), bottom = p.top + Math.min(size.height, p.maxHeight);
    assert.ok(p.left >= 8 && p.left + size.width <= viewport.width - 8);
    assert.ok(p.top >= 8 && bottom <= viewport.height - 8);
    assert.ok(bottom <= anchor.top - 6 || p.top >= anchor.bottom + 6);
  }
});
test('the assistance explanation is authored once and describes both the purpose and the limits', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="assistance">Assistance<\/label><button id="assistance-help-button"/);
  assert.match(html, /id="assistance-help-button"[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*aria-controls="assistance-help assistance-help-preview"/);
  assert.match(html, /<span aria-hidden="true">\?<\/span>/);
  const dialog = html.match(/<dialog id="assistance-help"[\s\S]*?<\/dialog>/)[0];
  assert.match(dialog, /aria-labelledby="assistance-help-title" aria-describedby="assistance-help-intro"/);
  assert.match(dialog, /Assistance is OK here/);
  assert.match(dialog, /testing the model’s decisions, not its ability to execute/);
  assert.match(dialog, /survival-biased actions/);
  assert.match(dialog, /14 fixed movement\/look\/fire inputs/);
  assert.match(dialog, /not RGB-only vision/);
  assert.match(dialog, /Compare runs with the same setting/);
  assert.match(dialog, /chosen model action is never silently replaced/);
  assert.equal((html.match(/Assistance is OK here/g) || []).length, 1);
  assert.match(html, /id="assistance-help-preview"[^>]*aria-modal="false"[^>]*hidden/);
});
