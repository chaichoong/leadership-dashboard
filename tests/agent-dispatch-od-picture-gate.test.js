import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE OD POST PICTURE GATE — od_picture_problem in scripts/agent-dispatch.py.
//
// Kevin's ruling, 9 Sep 2026: an Operations Director post card must carry its picture
// as a permanent link he can open, or the submit is refused. That rule is right and
// stays.
//
// What it was never meant to refuse is a CLOSE PROPOSAL. A close is ABOUT the card —
// "this post is stale, take it off the board" — so demanding the post's picture demands
// the very thing the close exists to get rid of. recZdwbWGIFjMEyG6, a stale OD post
// card, was resubmitted as a CLOSE PROPOSAL by the Task Manager and refused every time.
// The agent retried it in the 13:00 and 17:00 slots, both ended VERIFY FAIL, and it ran
// that way for six days (14, 16, 17, 18, 19, 20 Sep 2026): two of three board passes a
// day lost, the card never leaving the board, and five separate findings filed for one
// cause (541, 547, 553, 554, 556).
//
// The alert lane a few hundred lines below this gate already carries the identical
// exemption, for the identical reason, written after the identical incident in Sep 2026
// (recPqpTwyBCWs3mPs, blocked three slots running). This gate simply never got it.
//
// The function is read out of the real source and run, not re-implemented here: a copy
// of the rule in JS would pass while the shipped rule stayed broken.
function problem(taskName, output) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m.od_picture_problem(json.loads(sys.argv[1]), json.loads(sys.argv[2]))))
`;
  const out = execFileSync('python3', ['-c', script, JSON.stringify(taskName), JSON.stringify(output)], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const CARD = 'CONTENT (OD): Monday post — why founder dependency caps profit';
const PICTURE = 'https://assets.cdn.filesafe.space/abc123/monday-post.png';

describe('OD post picture gate', () => {
  it('still refuses an OD post card submitted with no openable picture link', () => {
    expect(problem(CARD, 'POST: Here is the copy for Monday.\n\nNo picture anywhere.')).toMatch(/permanent link/);
  });

  it('still passes an OD post card that carries its picture link', () => {
    expect(problem(CARD, `POST: copy\n\nPicture: ${PICTURE}`)).toBe('');
  });

  it('passes a CLOSE PROPOSAL on an OD post card — the close is about the card, not the post', () => {
    expect(problem(CARD, 'CLOSE PROPOSAL: stale — this post was for a date that has passed and was never published.')).toBe('');
  });

  it('passes a CLOSE PROPOSAL whatever its casing or leading whitespace', () => {
    expect(problem(CARD, '\n  close proposal: duplicate of recAbCdEfGhIjKlM')).toBe('');
  });

  it('does not let a close proposal MENTIONED mid-output slip a real post through', () => {
    expect(problem(CARD, 'POST: copy for Monday.\n\nI considered a CLOSE PROPOSAL: but the post is fine.')).toMatch(/permanent link/);
  });

  it('leaves the other two exemptions alone: a THIN SLOT card and a newsletter card', () => {
    expect(problem(CARD, 'THIN SLOT: nothing worth posting today.')).toBe('');
    expect(problem('CONTENT (OD): Newsletter: September edition', 'Here is the newsletter copy.')).toBe('');
  });

  it('never fires on a card that is not an OD post', () => {
    expect(problem('PROPERTY: EICR renewal at 6 Chedburgh Place', 'No picture here.')).toBe('');
  });
});
