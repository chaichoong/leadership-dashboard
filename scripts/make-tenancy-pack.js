#!/usr/bin/env node
/**
 * make-tenancy-pack.js — build one property's signing pack from live Airtable
 * data and the templates in ~/knowledge-os/templates.
 *
 * WHY (Kevin, 10 Sep 2026): the Growth Plan says what each property needs; this
 * produces the actual paper, so a visit is "print these, sign these" rather than
 * "write these first". Adobe Sign's API is unavailable on Kevin's plan, so the
 * PDFs go to Adobe through the browser afterwards (agent-browser.js prepare).
 *
 * A JOINT TENANCY'S TERM START IS NOT TODAY. Kevin's rule: it runs from the date
 * the household of two actually began, which is the date the SECOND tenant moved
 * in. That is the date the council tax claim is argued from, and it is the only
 * date that is true on the face of the document. Rent changes run from today.
 *
 * USAGE
 *   node scripts/make-tenancy-pack.js --property "6 Chedburgh Place" [--dry]
 *   node scripts/make-tenancy-pack.js --all [--dry]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');
// The one-bed rate is NOT a constant: it is the LHA figure for that property's
// broad rental market area. Cambridge is £897.52 and Manchester is £772.89, and
// putting the Cambridge number on a Manchester agreement would be a false rent.
const MODEL = require(path.join(__dirname, '..', 'js', 'growth-plan-model.js'));

const BASE = 'appnqjDpqDniH3IRl';
const TPL = path.join(os.homedir(), 'knowledge-os', 'templates');
const OUT = path.join(os.homedir(), 'knowledge-os', 'attachments');
const PAT = fs.readFileSync(path.join(os.homedir(), '.config', 'od', 'airtable_pat'), 'utf8').trim();
const TODAY = new Date().toISOString().slice(0, 10);

const die = (m) => { console.error('make-tenancy-pack: ' + m); process.exit(1); };
const gbp = (n) => '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()]} ${d.getFullYear()}`;
};

function api(pathAndQuery) {
  return new Promise((res, rej) => {
    https.get({ hostname: 'api.airtable.com', path: '/v0/' + BASE + pathAndQuery, headers: { Authorization: 'Bearer ' + PAT } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { const j = JSON.parse(d); if (j.error) rej(new Error(JSON.stringify(j.error))); else res(j); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function all(table, fields, formula) {
  const out = []; let offset = null;
  do {
    const q = new URLSearchParams(); q.set('pageSize', '100');
    fields.forEach((f) => q.append('fields[]', f));
    if (formula) q.set('filterByFormula', formula);
    if (offset) q.set('offset', offset);
    const r = await api(`/${table}?${q}`); out.push(...r.records); offset = r.offset || null;
  } while (offset);
  return out;
}

function fill(template, map) {
  let s = fs.readFileSync(path.join(TPL, template), 'utf8');
  for (const [k, v] of Object.entries(map)) s = s.split('[' + k + ']').join(v == null ? '' : String(v));
  return s;
}

function renderPdf(spec, dry) {
  if (dry) { console.log(`   would write ${spec.name}.pdf`); return null; }
  const out = execFileSync('node', [path.join(__dirname, 'make-document.js'), '--spec', '-'],
    { input: JSON.stringify(spec), encoding: 'utf8' });
  return JSON.parse(out).pdf;
}

// West Suffolk's benefits are run by Anglia Revenues Partnership; anywhere else
// is its own council, and naming the wrong one puts the claim in the wrong place.
function councilFor(area, postcode) {
  const pc = String(postcode || '').toUpperCase();
  if (pc.startsWith('CB9')) return { council: 'West Suffolk Council', team: 'Anglia Revenues Partnership' };
  if (pc.startsWith('CB7')) return { council: 'East Cambridgeshire District Council', team: 'Anglia Revenues Partnership' };
  if (pc.startsWith('M40')) return { council: 'Manchester City Council', team: 'Manchester City Council benefits team' };
  return { council: `${area || 'the'} council`, team: `${area || 'the'} council benefits team` };
}

async function main(argv) {
  const dry = argv.includes('--dry');
  const wanted = argv.includes('--property') ? argv[argv.indexOf('--property') + 1] : null;
  if (!wanted && !argv.includes('--all')) die('usage: --property "6 Chedburgh Place" | --all [--dry]');

  const props = await all('tbl6f0OkAmTC2jbuG',
    ['Property Name (Short)', 'Property', '📮 Postcode', '🏙️ Area', 'Growth Strategy', 'Planned Extra Tenants']);
  const tenants = await all('tblX4elTuu01gwBYh',
    ['Tenant Name', 'Tenant Status', 'Date of Birth', 'National Insurance Number', 'Rent Payment Type',
     'Benefit Cap Exemption', 'Aged 35 or Over (confirmed)', 'Council Tax Account Number']);
  const tenancies = await all('tblN51a88qTDB6iMH',
    ['Customers', 'Property', 'Tenancy Start Date', 'Expected Monthly Rent', 'Tenancy Status']);
  const byId = Object.fromEntries(tenants.map((t) => [t.id, t.fields]));

  // Parked by Kevin on 10 Sep 2026: no council tax is billed there, so the joint
  // tenancy buys nothing yet. Named explicitly on the command line, it still builds.
  const PARKED = ['1406 Oldham Road'];
  const targets = props.filter((p) => {
    const n = p.fields['Property Name (Short)'];
    const strat = p.fields['Growth Strategy'];
    if (wanted) return n === wanted;
    return (strat === 'Joint tenancy' || strat === 'HMO') && !PARKED.includes(n);
  });
  if (!targets.length) die('no property matched');

  const made = [];
  for (const p of targets) {
    const name = p.fields['Property Name (Short)'];
    const address = p.fields.Property || name;
    const { council, team } = councilFor(p.fields['🏙️ Area'], p.fields['📮 Postcode']);
    const strategy = p.fields['Growth Strategy'];
    const rates = MODEL.ratesFor(p.fields['📮 Postcode'], {});
    if (!rates) { console.log(`   no LHA rate for ${p.fields['📮 Postcode'] || 'a missing postcode'}: skipped`); continue; }
    const oneBed = rates.b1;
    const live = tenancies.filter((t) => (t.fields.Property || [])[0] === name && t.fields['Tenancy Status'] === 'Live' && t.fields['Tenancy Start Date']);
    live.sort((a, b) => a.fields['Tenancy Start Date'].localeCompare(b.fields['Tenancy Start Date']));
    const people = live.map((t) => ({
      id: (t.fields.Customers || [])[0],
      name: (byId[(t.fields.Customers || [])[0]] || {})['Tenant Name'] || '(unnamed)',
      f: byId[(t.fields.Customers || [])[0]] || {},
      rent: t.fields['Expected Monthly Rent'] || 0,
      start: t.fields['Tenancy Start Date'],
    })).filter((x) => x.id);

    console.log(`\n== ${name} (${strategy || 'no strategy'}) — ${people.length} live tenant(s), ${council}`);
    if (!people.length) { console.log('   no live tenancy: skipped'); continue; }

    if (strategy === 'Joint tenancy') {
      if (people.length !== 2) { console.log(`   joint tenancy needs exactly 2 tenants, found ${people.length}: skipped`); continue; }
      const [a, b] = people;
      // The household of two began when the SECOND tenant moved in.
      const termStart = people[people.length - 1].start;
      const total = oneBed * 2;
      const map = {
        'Agreement date': longDate(TODAY), 'Term start date': longDate(termStart),
        'First payment date': longDate(termStart),
        'Tenant 1 Name': a.name, 'Tenant 2 Name': b.name,
        'Tenant 1 first name': a.name.split(' ')[0], 'Tenant 2 first name': b.name.split(' ')[0],
        'Property address': address, 'Total rent': gbp(total),
        'tenancy start date': longDate(termStart), Date: longDate(TODAY), Council: council,
      };
      made.push(renderPdf({
        name: `AST_Joint_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
        title: 'Assured shorthold tenancy agreement',
        reference: `${address} — joint tenancy of ${a.name} and ${b.name}, term from ${longDate(termStart)}`,
        footer: `${name} — joint tenancy — not valid until signed by all three parties`,
        markdown: fill('ast_joint_template.md', map),
      }, dry));
      made.push(renderPdf({
        name: `Council_Tax_Side_Letter_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
        title: 'Council tax: side letter',
        reference: `${address} — separate from the tenancy agreement`,
        footer: `${name} — council tax side letter`,
        markdown: fill('council_tax_side_letter_template.md', map),
      }, dry));
      console.log(`   joint tenancy from ${termStart} (${b.name} moved in), rent ${gbp(total)} = 2 x ${rates.brma} 1-bed ${gbp(oneBed)}`);
    }

    for (const person of people) {
      const f = person.f;
      const age = MODEL.ageOn(f['Date of Birth'], TODAY);
      const over35 = age != null ? age >= 35 : !!f['Aged 35 or Over (confirmed)'];
      const uc = f['Rent Payment Type'] === 'Universal Credit';
      // Both joint tenants need an authority whatever we hold on them: the claim
      // is made in both names, and the gaps are filled at the meeting.
      if (uc && (over35 || strategy === 'Joint tenancy')) {
        made.push(renderPdf({
          name: `Authority_${person.name.replace(/[^A-Za-z0-9]+/g, '_')}_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
          title: 'Authority to act: council tax reduction and housing payment',
          reference: `${person.name} — ${address}`,
          footer: `${person.name} — authority to act — ${council}`,
          allowPlaceholders: true,   // DOB and NI are filled in at the meeting where we do not hold them
          markdown: fill('authority_to_act_template.md', {
            'Council benefits team': team, Council: council,
            'Tenant Name': person.name, DOB: f['Date of Birth'] ? longDate(f['Date of Birth']) : '________________',
            NI: f['National Insurance Number'] || '________________',
            'Property address': address,
            'CT account': f['Council Tax Account Number'] || '________________',
            'Landlord email': 'kevin@runpreneur.org.uk',
          }),
        }, dry));
      }
      // A rent change letter only where the rent actually moves and no joint
      // agreement is carrying the change instead.
      if (strategy !== 'Joint tenancy' && uc && over35 && person.rent > 0 && person.rent < oneBed - 0.5) {
        made.push(renderPdf({
          name: `Rent_Change_${person.name.replace(/[^A-Za-z0-9]+/g, '_')}`,
          title: 'Rent change',
          reference: `${person.name} — ${address}`,
          footer: `${person.name} — rent change from ${longDate(TODAY)}`,
          markdown: fill('rent_change_letter_template.md', {
            Date: longDate(TODAY), 'Tenant Name': person.name, 'Tenant first name': person.name.split(' ')[0],
            'Property address': address, 'old rent': gbp(person.rent), 'new rent': gbp(oneBed),
            'effective date': longDate(TODAY),
          }),
        }, dry));
        console.log(`   rent change ${person.name}: ${gbp(person.rent)} -> ${gbp(oneBed)} (${rates.brma}, age ${age != null ? age : '35+ confirmed'})`);
      }
    }
  }
  const written = made.filter(Boolean);
  console.log(`\n${written.length} document(s) written to ${OUT}`);
  written.forEach((f) => console.log('  ' + path.basename(f)));
}

main(process.argv.slice(2)).catch((e) => die(e.message));
