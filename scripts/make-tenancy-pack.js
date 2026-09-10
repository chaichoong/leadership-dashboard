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
 *   node scripts/make-tenancy-pack.js --tenant "Gary Walker" [--dry]
 *   node scripts/make-tenancy-pack.js --new --name "Jane Doe" --property "5 Dalham Place" \
 *                                     [--start 2026-10-01] [--dry]
 *
 * THE POINT OF --new (Kevin, 10 Sep 2026): every time a room is let, one command
 * produces that tenant's whole pack, so nobody is assembling paperwork by hand and
 * nobody forgets the proof of residency. The property's own strategy decides which
 * pack: a joint tenancy house gets the joint agreement, an HMO gets the single one.
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

// WHO NEEDS WHAT (Kevin, 10 Sep 2026, reviewing the first full list)
//
// PROOF OF RESIDENCY is a derived rule, not a list: Universal Credit only asks
// for one when the tenancy it is verifying is NEW or CHANGED. A tenant whose
// rent and agreement are untouched has nothing for UC to re-verify, so no
// proof. That rule reproduces every call Kevin made, so it is coded rather
// than listed, and it keeps working as tenants come and go.
//
// AUTHORITY TO ACT could not be derived. Kevin dropped it at 5 Dalham Place and
// for David Pinder, and kept it everywhere else, including tenants with no rent
// change at 55 Elmdon Place and 13 Chedburgh Place. The exceptions are listed
// here with his name and the date on them, so every gap is attributable and
// nothing is silently inferred.
const NO_AUTHORITY_PROPERTY = ['5 Dalham Place'];
const NO_AUTHORITY_TENANT = ['David Pinder'];
// Tristram Guthrie has no date of birth on file, so the age test could not put
// him on the one-bed rate. Kevin's instruction to raise his agreement at that
// rate IS the confirmation that he is 35 or over. His rent is £524.52 today.
const CONFIRMED_OVER_35 = ['Tristram Guthrie'];
// WHO HOLDS THE EARLIER-TERM AGREEMENT (Kevin, 10 Sep 2026). By default it is
// whoever moved in first. At 1406 Oldham Road Kevin says it is William Aiton,
// not Neil Huggins, and deleted the Neil Huggins draft. Airtable records Neil
// from 12 Dec 2019 and William from 3 Jan 2025, so the record and the instruction
// disagree; the instruction wins, and the term date still comes from the
// property's first tenancy, which is what the backdated council tax covers.
const EARLIER_TERM_HOLDER = { '1406 Oldham Road': 'William Aiton' };

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
  const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const wantedTenant = arg('--tenant');
  const isNew = argv.includes('--new');
  const newName = arg('--name');
  const newStart = arg('--start') || TODAY;
  let wanted = arg('--property');
  if (isNew) {
    if (!newName) die('--new needs --name "Their Name"');
    if (!wanted) die('--new needs --property "5 Dalham Place"');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart)) die('--start must be YYYY-MM-DD');
  }
  if (!wanted && !wantedTenant && !argv.includes('--all')) {
    die('usage: --property "6 Chedburgh Place" | --tenant "Gary Walker" | --new --name N --property P | --all [--dry]');
  }

  const props = await all('tbl6f0OkAmTC2jbuG',
    ['Property Name (Short)', 'Property', '📮 Postcode', '🏙️ Area', 'Growth Strategy', 'Planned Extra Tenants']);
  const tenants = await all('tblX4elTuu01gwBYh',
    ['Tenant Name', 'Tenant Status', 'Date of Birth', 'National Insurance Number', 'Rent Payment Type',
     'Benefit Cap Exemption', 'Aged 35 or Over (confirmed)', 'Council Tax Account Number']);
  const tenancies = await all('tblN51a88qTDB6iMH',
    ['Customers', 'Property', 'Tenancy Start Date', 'Expected Monthly Rent', 'Tenancy Status']);
  const byId = Object.fromEntries(tenants.map((t) => [t.id, t.fields]));

  if (wantedTenant) {
    const t = tenants.find((x) => (x.fields['Tenant Name'] || '').toLowerCase() === wantedTenant.toLowerCase());
    if (!t) die(`no tenant called "${wantedTenant}"`);
    const tc = tenancies.find((x) => (x.fields.Customers || []).includes(t.id) && x.fields['Tenancy Status'] === 'Live');
    if (!tc) die(`${wantedTenant} has no live tenancy`);
    wanted = (tc.fields.Property || [])[0];
    if (!wanted) die(`${wantedTenant}'s tenancy has no property`);
    console.log(`${wantedTenant} lives at ${wanted}`);
  }
  const targets = props.filter((p) => {
    const n = p.fields['Property Name (Short)'];
    const strat = p.fields['Growth Strategy'];
    if (wanted) return n === wanted;
    return strat === 'Joint tenancy' || strat === 'HMO';
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

    if (isNew) {
      // Nobody is in Airtable yet, so the pack comes from the flags plus the
      // property's own strategy and LHA rate.
      console.log(`\n== ${name} (${strategy || 'no strategy'}) — new tenant ${newName}, ${council}`);
      if (strategy === 'Joint tenancy') {
        die('this property is on a joint tenancy: a new tenant needs the joint agreement, ' +
            'which names both people. Run --property "' + name + '" once both are known.');
      }
      made.push(renderPdf({
        name: `AST_${newName.replace(/[^A-Za-z0-9]+/g, '_')}_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
        title: 'Assured shorthold tenancy agreement',
        reference: `${newName} — ${address} — one room, ${gbp(oneBed)} a month from ${longDate(newStart)}`,
        footer: `${newName} — ${name} — not valid until signed by both parties`,
        markdown: fill('ast_single_template.md', {
          'Agreement date': longDate(TODAY), 'Term start date': longDate(newStart),
          'First payment date': longDate(newStart), 'Tenant Name': newName,
          'Property address': address, Rent: gbp(oneBed),
        }),
      }, dry));
      made.push(renderPdf({
        name: `Proof_of_Residency_${newName.replace(/[^A-Za-z0-9]+/g, '_')}`,
        title: 'Proof of residency', reference: `${newName} — ${address}`,
        footer: `${newName} — proof of residency — Agile Lets Limited`,
        markdown: fill('proof_of_residency_template.md', {
          'Tenant Name': newName, 'Property address': address,
          Date: longDate(TODAY), 'Tenancy start': longDate(newStart),
        }),
      }, dry));
      made.push(renderPdf({
        name: `Authority_${newName.replace(/[^A-Za-z0-9]+/g, '_')}_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
        title: 'Authority to act: council tax reduction and housing payment',
        reference: `${newName} — ${address}`,
        footer: `${newName} — authority to act — ${council}`,
        allowPlaceholders: true,
        markdown: fill('authority_to_act_template.md', {
          'Council benefits team': team, Council: council, 'Tenant Name': newName,
          DOB: '________________', NI: '________________',
          'Property address': address, 'CT account': '________________',
        }),
      }, dry));
      console.log(`   HMO pack for ${newName}: agreement at ${gbp(oneBed)} from ${newStart}, proof of residency, authority`);
      continue;
    }

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
      console.log(`   joint tenancy from ${termStart} (${b.name} moved in), rent ${gbp(total)} = 2 x ${rates.brma} 1-bed ${gbp(oneBed)}`);
      // The earlier period: one tenant, whole property, from their own move-in.
      // Same clauses, singular, at what they were actually paying.
      const holderName = EARLIER_TERM_HOLDER[name];
      const holder = holderName ? (people.find((p) => p.name === holderName) || a) : a;
      if (a.start && a.start < termStart) {
        made.push(renderPdf({
          name: `AST_Whole_${holder.name.replace(/[^A-Za-z0-9]+/g, '_')}_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
          title: 'Assured shorthold tenancy agreement',
          reference: `${holder.name} — ${address} — whole property, term from ${longDate(a.start)}`,
          footer: `${name} — ${holder.name} — earlier term — not valid until signed by both parties`,
          markdown: fill('ast_whole_single_template.md', {
            'Agreement date': longDate(TODAY), 'Term start date': longDate(a.start),
            'First payment date': longDate(a.start), 'Tenant Name': holder.name,
            'Property address': address, 'Total rent': gbp(a.rent || oneBed),
          }),
        }, dry));
        console.log(`   earlier term ${holder.name} alone from ${a.start} at ${gbp(a.rent || oneBed)}`);
      }
    }

    for (const person of people) {
      if (wantedTenant && person.name.toLowerCase() !== wantedTenant.toLowerCase()) continue;
      const f = person.f;
      const age = MODEL.ageOn(f['Date of Birth'], TODAY);
      const over35 = CONFIRMED_OVER_35.includes(person.name)
        || (age != null ? age >= 35 : !!f['Aged 35 or Over (confirmed)']);
      const uc = f['Rent Payment Type'] === 'Universal Credit';
      // Decide the agreement FIRST, because the proof of residency depends on it.
      const raisesAst = strategy !== 'Joint tenancy' && uc && over35
        && person.rent > 0 && person.rent < oneBed - 0.5;
      const signsNewTenancy = raisesAst || strategy === 'Joint tenancy';
      // Proof of residency: Universal Credit asks for a proof of address and these
      // tenants have no utility bill in their name, so Agile Lets confirms it.
      // Only where the tenancy is new or changed (Kevin, 10 Sep 2026): a tenant
      // whose agreement and rent are untouched has nothing for UC to re-verify.
      if (uc && signsNewTenancy) {
        // No title or reference line: this is the letter Agile Lets already sends,
        // and Kevin wants it to look like the one Universal Credit has seen before.
        const addrLines = String(address).split(',').map((x) => x.trim()).filter(Boolean);
        made.push(renderPdf({
          name: `Proof_of_Residency_${person.name.replace(/[^A-Za-z0-9]+/g, '_')}`,
          footer: `${person.name} — proof of residency — Agile Lets Limited`,
          markdown: fill('proof_of_residency_template.md', {
            'Tenant Name': person.name, 'Property address': address,
            'Property line 1': addrLines[0] || '', 'Property line 2': addrLines[1] || '',
            'Property line 3': addrLines[2] || '', 'Property line 4': addrLines[3] || '',
            Date: longDate(TODAY),
            'Tenancy start': longDate(strategy === 'Joint tenancy' ? people[people.length - 1].start : person.start),
          }),
        }, dry));
      }
      // Every tenant Roy sees signs an authority, whatever we hold on them
      // (Kevin, 10 Sep 2026). It is what lets Roy or Kevin submit the Council
      // Tax Reduction form and any CRF Housing Payment, and the gaps are
      // filled in at the meeting. Age does not decide it: two tenants have no
      // date of birth on file, and a joint claim is made in both names.
      if (uc && !NO_AUTHORITY_PROPERTY.includes(name) && !NO_AUTHORITY_TENANT.includes(person.name)) {
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
            }),
        }, dry));
      }
      // A rent rise is a NEW TENANCY, not a letter about one (Kevin, 10 Sep 2026).
      // The HMO tenant signs the standard agreement at the new rate, with the
      // single-room clause: the old "two rooms above £897.52" wording is gone,
      // because the whole point is that one room now earns the one-bed rate.
      if (raisesAst) {
        made.push(renderPdf({
          name: `AST_${person.name.replace(/[^A-Za-z0-9]+/g, '_')}_${name.replace(/[^A-Za-z0-9]+/g, '_')}`,
          title: 'Assured shorthold tenancy agreement',
          reference: `${person.name} — ${address} — one room, ${gbp(oneBed)} a month from ${longDate(TODAY)}`,
          footer: `${person.name} — ${name} — not valid until signed by both parties`,
          markdown: fill('ast_single_template.md', {
            'Agreement date': longDate(TODAY), 'Term start date': longDate(TODAY),
            'First payment date': longDate(TODAY), 'Tenant Name': person.name,
            'Property address': address, Rent: gbp(oneBed),
          }),
        }, dry));
        console.log(`   new AST ${person.name}: ${gbp(person.rent)} -> ${gbp(oneBed)} (${rates.brma}, age ${age != null ? age : '35+ confirmed'})`);
      }
    }
  }
  const written = made.filter(Boolean);
  console.log(`\n${written.length} document(s) written to ${OUT}`);
  written.forEach((f) => console.log('  ' + path.basename(f)));
}

main(process.argv.slice(2)).catch((e) => die(e.message));
