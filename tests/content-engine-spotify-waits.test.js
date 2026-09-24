// The Spotify upload's status waits must read Spotify's own words, never the episode's copy (24 Sep 2026).
// `text=Uploading` matched 2070's description ("uploading your bank statements") in the editor, so the wait for the
// upload to finish never ended and every hourly retry left an Untitled draft. Drives the REAL plan's selectors in a page.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const DIR = path.resolve(__dirname, '../scripts/content-engine');
const plan = JSON.parse(execFileSync('python3', ['-c',
  'import json, spotify; print(json.dumps(spotify.build_plan("/x.mp4", "T", "I tried uploading and processing my statements, then generating preview files", "", True)))'],
  { cwd: DIR, encoding: 'utf8' }));
const gone = plan.steps.filter((s) => s.do === 'wait' && s.gone).map((s) => s.gone);
const editor = '<div contenteditable="true"><p><span data-slate-string="true">Uploading, Processing and Generating preview are words in my copy.</span></p></div>';

describe('Spotify upload waits read the page, not the copy', () => {
  it('has the three status waits', () => { expect(gone.length).toBe(3); });

  it('a status word inside the description never holds a wait; the real status word does', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const sel of gone) {
        await page.setContent('<div>' + editor + '</div>');
        await page.waitForSelector(sel, { state: 'hidden', timeout: 2000 });        // throws if the copy holds it (the 2070 fault)
        const word = sel.match(/:text\("([^"]+)"\)/)[1];
        await page.setContent('<div><span>' + word + ' 40%</span>' + editor + '</div>');
        await expect(page.waitForSelector(sel, { state: 'hidden', timeout: 800 })).rejects.toThrow();
      }
    } finally { await browser.close(); }
  }, 30000);
});

describe('the Spotify thumbnail is confirmed selected before Next (2061, 2068, 2069 went out with a frame)', () => {
  const sel = JSON.parse(execFileSync('python3', ['-c', 'import json, spotify; print(json.dumps(spotify.THUMB_SELECTED))'], { cwd: DIR, encoding: 'utf8' }));
  const tile = (checked, inner) => '<button role="radio" aria-checked="' + checked + '" type="button">' + inner + '</button>';
  it('matches only when the checked tile is the uploaded image, never a frame', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="thumbnail-list" role="radiogroup">' + tile(true, '<canvas></canvas>') + tile(false, '<img alt="Uploaded thumbnail" src="data:,">') + '</div>');
      expect(await page.locator(sel).count()).toBe(0);                 // frame 1 selected: the 2061/2068/2069 state
      await page.setContent('<div id="thumbnail-list" role="radiogroup">' + tile(true, '<img alt="Uploaded thumbnail" src="data:,">') + tile(false, '<canvas></canvas>') + '</div>');
      expect(await page.locator(sel).count()).toBe(1);                 // the branded upload selected
    } finally { await browser.close(); }
  }, 30000);
});

