// Guards for the UK gigs check (28 Sep 2026).
//
// The failures these exist for:
//
//  1. A keyword search for "Queen" returns every tribute act with Queen in its
//     name. Matching must be on the attraction's own name, so a tribute band's
//     gigs never reach Kevin as the real thing.
//  2. A lookup that breaks (bad key, changed API) finds no gigs, and "no gigs"
//     reads exactly like "nobody is touring". The check must FAIL when it
//     matches almost none of the artists, and a quiet month still gets an email.
//  3. Kevin is told about each gig once. A gig he has been told about is never
//     "new" again, and a rerun of the same check sends nothing twice.
//  4. The artist list comes from track counts. A joint credit adds to the solo
//     artist it names; a group name is never split into made-up artists.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/uk-gigs.py');

// Loads the script as a module and runs `body`, which must set `out`.
function py(body) {
    const code = `
import importlib.util, json, datetime as dt
spec = importlib.util.spec_from_file_location('ug', ${JSON.stringify(script)})
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
today = dt.date(2026, 9, 28)
MUSIC = [{'segment': {'name': 'Music'}}]
def ev(i, date, seg='Music', status='onsale'):
    return {'id': i, 'name': 'x', 'classifications': [{'segment': {'name': seg}}],
            'dates': {'start': {'localDate': date, 'localTime': '19:30:00'}, 'status': {'code': status}},
            '_embedded': {'venues': [{'name': 'The O2', 'city': {'name': 'London'}}]},
            'url': 'https://t/' + i}
class FakeTM:
    def __init__(self, atts, events):
        self.atts, self.evs, self.calls = atts, events, 0
    def attractions(self, name):
        self.calls += 1
        return self.atts.get(name, [])
    def events(self, aid):
        self.calls += 1
        return self.evs.get(aid, [])
${body}
print(json.dumps(out, default=str))
`;
    return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim());
}

describe('uk-gigs', () => {
    it('offline selftest passes', () => {
        const out = execFileSync('python3', [script, 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('never takes a tribute act for the artist', () => {
        // Back-tested 28 Sep 2026: matching with `want in norm(name)` instead of
        // `==` returns the tribute act's gig and fails this test.
        const out = py(`
tm = FakeTM({'Queen': [
    {'id': 'trib', 'name': 'Bohemian Rhapsody - A Tribute to Queen', 'classifications': MUSIC},
    {'id': 'real', 'name': 'Queen', 'classifications': MUSIC}]},
    {'trib': [ev('t1', '2027-01-01')], 'real': [ev('r1', '2027-02-01')]})
found, missing, errors = ug.look_up(['Queen'], tm, today)
out = [g['id'] for g in found['Queen']['gigs']]`);
        expect(out).toEqual(['r1']);
    });

    it('lists an artist with no exact match as not found, never as quiet', () => {
        const out = py(`
tm = FakeTM({'Blur': [{'id': 'b', 'name': 'Blurred Lines Tribute', 'classifications': MUSIC}]}, {})
found, missing, errors = ug.look_up(['Blur'], tm, today)
out = [sorted(found), missing]`);
        expect(out).toEqual([[], ['Blur']]);
    });

    it('drops add-on listings, cancelled and past gigs', () => {
        const out = py(`
tm = FakeTM({'Queen': [{'id': 'q', 'name': 'Queen', 'classifications': MUSIC}]},
    {'q': [ev('park', '2027-01-01', seg='Miscellaneous'), ev('gone', '2027-01-02', status='cancelled'),
           ev('past', '2026-09-01'), ev('ok', '2027-01-03')]})
found, missing, errors = ug.look_up(['Queen'], tm, today)
out = [g['id'] for g in found['Queen']['gigs']]`);
        expect(out).toEqual(['ok']);
    });

    it('fails loudly when Ticketmaster matches almost none of the artists', () => {
        // Back-tested 28 Sep 2026: deleting the MIN_RESOLVED_SHARE check lets this
        // run save state and report success with zero gigs.
        const out = py(`
ug.read_library = lambda: [('A%d' % i, '') for i in range(10) for _ in range(5)]
ug.read_key = lambda: 'k'
ug.Ticketmaster = lambda key: FakeTM({}, {})
ug.load_state = lambda: {}
saved = []
ug.save_json = lambda obj, path: saved.append(path)
try:
    ug.do_check(today)
    out = ['no error', saved]
except SystemExit as e:
    out = [str(e.code), saved]`);
        expect(out[0]).toMatch(/matched 0 of 10 artists/);
        expect(out[1]).toEqual([]);
    });

    it('puts tribute shows in their own section, never under the band', () => {
        // Kevin, 28 Sep 2026: tribute acts for favourite bands that no longer tour.
        // Back-tested 28 Sep 2026: dropping tribute_to in tribute_gigs() lists
        // "One Night of Queen" as an artist in the real list and fails this test.
        const out = py(`
import io, contextlib
ug.read_library = lambda: [('Queen', '')] * 5 + [('Oasis', '')] * 5
ug.read_key = lambda: 'k'
ug.load_tributes = lambda: {'Queen': ['One Night of Queen']}
tm = FakeTM({'Queen': [{'id': 'q', 'name': 'Queen', 'classifications': MUSIC}],
             'Oasis': [{'id': 'o', 'name': 'Oasis', 'classifications': MUSIC}],
             'One Night of Queen': [{'id': 'onq', 'name': 'One Night of Queen', 'classifications': MUSIC,
                                     'url': 'https://t/onq'}]},
            {'o': [ev('o1', '2027-07-01')], 'onq': [ev('n%d' % i, '2027-01-%02d' % (i + 1)) for i in range(8)]})
ug.Ticketmaster = lambda key: tm
ug.load_state = lambda: {}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    ug.do_check(today, dry_run=True)
text = buf.getvalue()
real = text.split('ALL UPCOMING UK GIGS')[1].split('TRIBUTE SHOWS FOR BANDS')[0]
trib = text.split('TRIBUTE SHOWS FOR BANDS')[1].split('WHAT WAS CHECKED')[0]
out = ['One Night' in real, 'Oasis' in real, 'Queen, played by One Night of Queen (tribute)' in trib,
       'and 3 more UK dates: https://t/onq' in trib, 'Tribute acts checked: 1.' in text]`);
        expect(out).toEqual([false, true, true, true, true]);
    });

    it('tells each gig once and sends the monthly heartbeat when nothing is new', () => {
        const out = py(`
g1 = {'id': 'e1', 'artist': 'Queen', 'date': '2027-03-14', 'time': '', 'venue': 'v', 'city': 'c',
      'status': 'onsale', 'onsale': '', 'url': ''}
g2 = dict(g1, id='e2')
first = ug.decide({}, [g1], today)
st = ug.after_check({}, [g1], today, True)
week = ug.decide(st, [g1, g2], dt.date(2026, 9, 30))
quiet = ug.decide(st, [g1], dt.date(2026, 9, 30))
october = ug.decide(st, [g1], dt.date(2026, 10, 5))
out = [first['kind'], week['kind'], [g['id'] for g in week['new']], quiet['kind'], october['kind']]`);
        expect(out).toEqual(['starting', 'new', ['e2'], null, 'heartbeat']);
    });

    it('checks weekly off a daily trigger', () => {
        const out = py(`
st = {'last_good_check': '2026-09-28'}
out = [ug.check_due(st, dt.date(2026, 10, 4)), ug.check_due(st, dt.date(2026, 10, 5)),
       ug.check_due(st, dt.date(2026, 10, 6)), ug.check_due({}, today)]`);
        expect(out).toEqual([false, true, true, true]);
    });

    it('credits joint names to solo artists and never splits a group', () => {
        const out = py(`
rows = ([('The Police', '')] * 4 + [('Sting & The Police', '')] * 2
        + [('Crosby, Stills & Nash', '')] * 5 + [('x', 'Various Artists')] * 9)
c = ug.count_artists(rows)
out = [c['The Police'], 'Sting & The Police' in c, 'Crosby' in c, 'Various Artists' in c, ug.pick_artists(c, 5)]`);
        // A compilation track counts for its own track artist ('x'), never for "Various Artists".
        expect(out).toEqual([6, false, false, false, ['Crosby, Stills & Nash', 'The Police', 'x']]);
    });

    it('uses the email prefix the send gate has registered', () => {
        const out = py(`
import re
src = open(ug.SEND_EMAIL).read()
spec2 = importlib.util.spec_from_file_location('se', ug.SEND_EMAIL)
se = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(se)
out = [ug.SUBJECT_PREFIX in se.SELF_NOTE_PREFIXES, ug.MIN_SONGS, ug.CHECK_EVERY_DAYS]`);
        expect(out).toEqual([true, 5, 7]);
    });
});
