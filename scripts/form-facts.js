#!/usr/bin/env node
// FORM FACTS (estate fix 3, Nov 2026): one private file of the facts web forms ask about a house
// and its owner (storeys, year built, rebuild cost, the owner's date of birth), so a fact Kevin gave
// once is read on the next form instead of being asked again. agent-browser.js reads it first when a
// handover plan says whose form it is ("factsFor").
//
// The facts live OUTSIDE this public repo: AGENT_FORM_FACTS, or ~/knowledge-os/handover/form-facts.json
// (0600). The repo holds only this reader, the schema (form-facts-schema.json) and tests with invented
// data. Every fact carries where it came from and its date, and goes stale on the schema's clock.
// Declarations (claims, convictions, refused insurance) are never facts: they live in Kevin's standing
// answers file under his own ruling, and this file refuses them.
// Forms round 2 (15 Nov 2026): a plan step reads one fact by its key ({{fact:<key>}}, resolveFact), and the
// answers Kevin gives in his own "Your turn" window are RECORDED in "captured" (addCaptured). A record never
// answers a form: after his window the agent runs `node scripts/form-facts.js captured --task <id>` and stores
// each real fact with `set` and its source, so the next form reads it as a fact. A declaration, a loss or a
// private value (card, bank, password, code, identity number) is never recorded: refused here and by the caller.
//
// USAGE (prints JSON; exits 1 with a plain message on a refusal)
//   node scripts/form-facts.js lines --owner <ref> [--property <ref>]... [--with-source]
//   node scripts/form-facts.js set --scope property|owner|general [--ref <ref>] --key <key> --value <v> --source <s>
//        [--date YYYY-MM-DD] [--label <l>] [--until YYYY-MM-DD]
//   node scripts/form-facts.js add-property --key <k> --address <a> --town <t> --postcode <p> [--owner <owner-key>]
//   node scripts/form-facts.js add-owner --key <k> --name <n>
//   node scripts/form-facts.js import --file <json>
//   node scripts/form-facts.js captured [--task <id>] [--site <host>] [--owner <ref>]
//   node scripts/form-facts.js check
//
// Two writers never lose each other's write: every load-change-write holds <file>.lock (a folder, made
// atomically) for its whole length. A lock older than 60 seconds is debris from a dead writer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECLARATION_TOPIC_RE, NEARBY_DECLARATION_RE, NEVER_ROBOT_RE, PRIVATE_QUESTION_RE, CAPTURE_LOSS_RE, GAS_RE, namesGasSafety } = require('./declaration-words');
const SCHEMA = require('./form-facts-schema.json');

const defaultFile = () => process.env.AGENT_FORM_FACTS || path.join(os.homedir(), 'knowledge-os', 'handover', 'form-facts.json');
const FACT_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const REF_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 365;
const WAS_MAX = 5;
// A first-person declaration is his too, however the label or value words it.
const I_DECLARE_RE = /\b(?:i|we|i\/we) (?:declare|confirm)\b/i;
// "Administrator" is an occupation, so a VALUE is screened without these words. Labels and keys keep them.
const OCCUPATION_WORDS_RE = /\badministrat(?:ors?|ion)\b/gi;
// Names that would reach a prototype if used as a key: never a fact key or a ref.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// A house's address is the tag on its fact lines ("Year built [12 Test Lane]: 1930"): these would break one.
const TAG_BREAK_RE = /[:\[\]]/;
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const LOCK_WAIT_MS = 10000, LOCK_STALE_MS = 60000, LOCK_RETRY_MS = 50;

const todayLondon = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
const emptyStore = () => ({ version: 1, general: { facts: {} }, owners: {}, properties: {} });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const validDate = d => DATE_RE.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'))
  && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
// The same normalising as lineKey in agent-browser.js: lower case, spaces collapsed, trailing punctuation off.
const normWords = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const lineKey = t => normWords(t).replace(/[.;,\s]+$/, '');
// Addresses and names: punctuation out as well.
const normPlace = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function refusal(msg) { const e = new Error(msg); e.refusal = true; return e; }

// The schema entry for a fact: property and owner keys from their own lists, a general key from either.
function schemaEntry(scope, key) {
  const from = list => (own(list, key) ? list[key] : null);
  if (scope === 'property') return from(SCHEMA.property);
  if (scope === 'owner') return from(SCHEMA.owner);
  return from(SCHEMA.property) || from(SCHEMA.owner);
}
const labelOf = (scope, key, fact) => String((fact && fact.label) || (schemaEntry(scope, key) || {}).label || key);
const goodForDays = (scope, key) => { const s = schemaEntry(scope, key); return s ? s.goodForDays : DEFAULT_DAYS; };

// Declarations are never facts: the words a label, key or value carries decide it.
function declarationIn(...texts) {
  for (const t of texts) {
    const s = String(t || '').replace(/-/g, ' ');
    const m = s.match(DECLARATION_TOPIC_RE) || s.match(I_DECLARE_RE);
    if (m) return m[0];
  }
  return '';
}
// The value is screened too ("No claims, no CCJs" is a declaration answer), occupation words aside.
const declarationInValue = v => declarationIn(String(v || '').replace(OCCUPATION_WORDS_RE, ' '));
const isFuture = (d, today = todayLondon()) => validDate(d) && d > today;
const DECLARATION_HELP = 'declarations are never facts: they live in Kevin\'s standing answers file under his own ruling';

// A gas answer is per house (Kevin, 16 Nov 2026, decision card recinoFWz6fQ6JVVB, ruling 4): "Yes" only where
// that house has a current certificate on file, and a house with none stops for him. A general or owner fact
// reaches every house's form, so a gas answer there would be the blanket yes he ruled out. A house's own gas
// safety fact (anything but a no, none or n/a) carries its certificate's expiry as "until", so it lapses with it.
const GAS_HELP = 'a gas answer is per house: store it on that house (--scope property --ref <house>) from its own current certificate, never for every house (Kevin, 16 Nov 2026)';
const keyWords = key => String(key || '').replace(/-/g, ' ');
// A house with no gas says so: "No", "No gas supply", "None", "N/A, all electric", "Not applicable". "Not expired" is a yes.
const NO_GAS_VALUE_RE = /^\s*(?:no|none|n\/?a|not applicable|not required)\b/i;
// A general or owner fact: any gas word in its key or label, or a value that names gas safety. A schema key's
// value is the owner's own detail (an occupation, an address) and is not read for it.
function gasIn(scope, key, label, value) {
  const m = `${keyWords(key)} | ${label || ''}`.match(GAS_RE);
  if (m) return m[0];
  if (schemaEntry(scope, key) || !namesGasSafety(value)) return '';
  return (String(value).match(GAS_RE) || ['gas safety'])[0];
}
const gasSafetyFact = (key, label, value) => namesGasSafety(`${keyWords(key)} | ${label || ''} | ${value || ''}`);
function gasProblem(scope, key, label, value, until) {
  if (scope !== 'property') {
    const gas = gasIn(scope, key, label, value);
    return gas ? `"${gas}" is a gas answer, and ${GAS_HELP}` : '';
  }
  if (gasSafetyFact(key, label, value) && !NO_GAS_VALUE_RE.test(String(value || '')) && !validDate(until)) {
    return `"${label || key}" is a house's gas safety answer, so it needs "until": the expiry date of that house's current certificate (Kevin, 16 Nov 2026)`;
  }
  return '';
}

// ── Reading and checking ──────────────────────────────────────────────────────────────────────
function factProblems(where, scope, key, f) {
  const out = [];
  if (!FACT_KEY_RE.test(key)) out.push(`${where}: "${key}" is not a fact key (lower case, digits and hyphens)`);
  if (!isObj(f)) { out.push(`${where}.${key}: not a fact`); return out; }
  if (typeof f.value !== 'string' || !f.value.trim()) out.push(`${where}.${key}: no value`);
  if (typeof f.source !== 'string' || !f.source.trim()) out.push(`${where}.${key}: no source (where the fact came from)`);
  if (!validDate(f.date)) out.push(`${where}.${key}: no date or a bad date (YYYY-MM-DD)`);
  else if (isFuture(f.date)) out.push(`${where}.${key}: dated ${f.date}, which is in the future`);
  if (f.until !== undefined && !validDate(f.until)) out.push(`${where}.${key}: "until" is not a date (YYYY-MM-DD)`);
  if (!schemaEntry(scope, key) && !String(f.label || '').trim()) out.push(`${where}.${key}: a key not in the schema needs its own label`);
  const dec = declarationIn(labelOf(scope, key, f), key) || declarationInValue(f.value);
  if (dec) out.push(`${where}.${key}: "${dec}" is a declaration topic, and ${DECLARATION_HELP}`);
  const gas = gasProblem(scope, key, labelOf(scope, key, f), f.value, f.until);
  if (gas) out.push(`${where}.${key}: ${gas}`);
  return out;
}

function validateStore(store) {
  const out = [];
  if (!isObj(store)) return ['the file is not a JSON object'];
  if (store.general !== undefined && !isObj(store.general)) out.push('"general" is not an object');
  if (store.owners !== undefined && !isObj(store.owners)) out.push('"owners" is not an object');
  if (store.properties !== undefined && !isObj(store.properties)) out.push('"properties" is not an object');
  if (out.length) return out;
  // "captured" (forms round 2) is a record, not facts: a bad entry is dropped on load (splitCaptured), never a failure here.
  const facts = (where, scope, obj) => {
    if (obj === undefined) return;
    if (!isObj(obj)) { out.push(`${where}: "facts" is not an object`); return; }
    for (const [k, f] of Object.entries(obj)) out.push(...factProblems(where, scope, k, f));
  };
  facts('general', 'general', (store.general || {}).facts);
  for (const [k, o] of Object.entries(store.owners || {})) {
    if (!REF_KEY_RE.test(k)) out.push(`owners: "${k}" is not a valid key`);
    if (!isObj(o) || !String(o.name || '').trim()) { out.push(`owners.${k}: no name`); continue; }
    facts(`owners.${k}`, 'owner', o.facts);
  }
  for (const [k, p] of Object.entries(store.properties || {})) {
    if (!REF_KEY_RE.test(k)) out.push(`properties: "${k}" is not a valid key`);
    if (!isObj(p) || !String(p.address || '').trim()) { out.push(`properties.${k}: no address`); continue; }
    if (TAG_BREAK_RE.test(`${p.address}${p.postcode || ''}`)) out.push(`properties.${k}: the address or postcode holds a colon or a square bracket, which would break its fact lines`);
    if (p.owner !== undefined && p.owner !== null && !own(store.owners || {}, p.owner)) out.push(`properties.${k}: owner "${p.owner}" is not in owners`);
    facts(`properties.${k}`, 'property', p.facts);
  }
  return out;
}

// Fills the sections a hand-made file left out, so every reader sees the full shape.
function normalise(store) {
  const s = Object.assign(emptyStore(), store);
  delete s.asked;   // an old file's log of asked questions (removed Nov 2026) is ignored
  s.general = Object.assign({ facts: {} }, s.general);
  for (const o of Object.values(s.owners)) if (!o.facts) o.facts = {};
  for (const p of Object.values(s.properties)) if (!p.facts) p.facts = {};
  return s;
}

// A missing file is an empty store. A file that will not parse or fails its checks THROWS: an empty
// read would mean every fact gets asked of Kevin again.
function loadStore(file = defaultFile()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyStore();
    throw refusal(`the facts file ${file} cannot be read: ${e.message}`);
  }
  let store;
  try { store = JSON.parse(raw); } catch (e) { throw refusal(`the facts file ${file} is not valid JSON: ${e.message}`); }
  // A bad recorded answer is dropped, the rest kept, the facts untouched (review R1): the next write leaves it out.
  if (isObj(store) && store.captured !== undefined) store.captured = splitCaptured(store.captured).kept;
  const problems = validateStore(store);
  if (problems.length) throw refusal(`the facts file ${file} fails its checks: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  return normalise(store);
}

// Written whole or not at all: a temp file in the same folder, flushed to disk, then renamed over.
function writeStore(store, file = defaultFile()) {
  const problems = validateStore(store);
  if (problems.length) throw refusal(`refused to write the facts file: ${problems[0]}`);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(store, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { e.message += ` (the temp file ${tmp} was left behind: ${e2.message})`; }
    throw e;
  }
}

// A house by its key, or by its address written in one of four exact forms: the first line; first line
// and town; first line and postcode; first line, town and postcode. Never by a prefix, never a guess.
function findProperty(store, ref) {
  const props = (store && store.properties) || {};
  if (!ref) return null;
  if (own(props, ref)) return isObj(props[ref]) ? Object.assign({ key: ref }, props[ref]) : null;
  const want = normPlace(ref);
  if (!want) return null;
  const hits = Object.entries(props).filter(([, p]) => {
    const first = normPlace(p && p.address);
    if (!first) return false;
    const town = normPlace(p.town), pc = normPlace(p.postcode);
    const forms = [first, town && `${first} ${town}`, pc && `${first} ${pc}`, town && pc && `${first} ${town} ${pc}`];
    return forms.some(f => f && f === want);
  });
  return hits.length === 1 ? Object.assign({ key: hits[0][0] }, hits[0][1]) : null;
}

function findOwner(store, ref) {
  const owners = (store && store.owners) || {};
  if (!ref) return null;
  if (own(owners, ref)) return isObj(owners[ref]) ? Object.assign({ key: ref }, owners[ref]) : null;
  const want = normWords(ref);
  const hits = Object.entries(owners).filter(([, o]) => normWords(o.name) === want);
  return hits.length === 1 ? Object.assign({ key: hits[0][0] }, hits[0][1]) : null;
}

const dayNumber = d => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
function isExpired(scope, key, f, today) {
  if (f.until) return f.until < today;
  const days = goodForDays(scope, key);
  if (days === null || days === undefined) return false;
  return dayNumber(today) - dayNumber(f.date) > days;
}
const placeLine = p => [p.address, p.town, p.postcode].map(x => String(x || '').trim()).filter(Boolean).join(', ');

// The fact lines a form planner reads: "Label: value", no source and no date inside the line. With two
// or more houses a house's line carries its address as a tag at the end of the label,
// "Label [12 Test Lane]: value", and each house has its own plain "Property: <address>" line. The
// planner's checks read only the value side of a line, so neither the tag nor the label backs a value.
function linesFor(store, opts = {}) {
  const today = opts.today || todayLondon();
  const lines = [], used = [], expired = [], missing = [], problems = [];
  const props = [];
  for (const ref of opts.properties || []) {
    const p = findProperty(store, ref);
    if (p) { if (!props.some(x => x.key === p.key)) props.push(p); } else problems.push({ scope: 'property', ref });
  }
  let owner = null;
  if (opts.owner) {
    owner = findOwner(store, opts.owner);
    if (!owner) problems.push({ scope: 'owner', ref: opts.owner });
  } else {
    // No owner named: the houses' own owner, when they share one.
    const keys = [...new Set(props.map(p => p.owner).filter(Boolean))];
    if (keys.length === 1 && props.every(p => p.owner === keys[0])) owner = findOwner(store, keys[0]);
  }
  // Tagged whenever the form names two or more houses, even when one of them is not on file: a line
  // with no tag would read as covering the whole form. Two houses with the same first line are told
  // apart by their postcodes.
  const many = props.length > 1 || new Set((opts.properties || []).map(r => normPlace(r))).size > 1;
  const sameFirst = p => props.filter(x => normPlace(x.address) === normPlace(p.address)).length > 1;
  const tagOf = p => (sameFirst(p) ? [p.address, p.postcode] : [p.address]).map(x => String(x || '').trim()).filter(Boolean).join(', ');
  // A form in one person's name for a house another owns is common: reported, never refused.
  const ownerDiffers = owner ? props.filter(p => p.owner && p.owner !== owner.key).map(p => ({ ref: p.key, address: p.address, owner: p.owner })) : [];
  const add = (scope, ref, facts, tag = '') => {
    for (const [key, f] of Object.entries(facts || {})) {
      const label = labelOf(scope, key, f);
      if (isExpired(scope, key, f, today)) { expired.push({ scope, ref, key, label, date: f.date, until: f.until || null }); continue; }
      const line = `${label}${tag ? ` [${tag}]` : ''}: ${f.value}`;
      lines.push(line);
      used.push({ scope, ref, key, label, value: f.value, source: f.source, date: f.date, line });
    }
  };
  const live = (scope, facts, key) => own(facts, key) && !isExpired(scope, key, facts[key], today);
  add('general', null, ((store && store.general) || {}).facts);
  if (owner) {
    add('owner', owner.key, owner.facts);
    for (const [key, s] of Object.entries(SCHEMA.owner)) if (!live('owner', owner.facts, key)) missing.push({ scope: 'owner', ref: owner.key, key, label: s.label });
  }
  props.forEach(p => {
    add('property', p.key, p.facts, many ? tagOf(p) : '');
    lines.push(`Property: ${placeLine(p)}`);
    for (const [key, s] of Object.entries(SCHEMA.property)) {
      if (!live('property', p.facts, key)) missing.push({ scope: 'property', ref: p.key, address: p.address, key, label: s.label });
    }
  });
  return { lines, used, expired, missing, problems, ownerDiffers, resolved: { owner: owner ? owner.key : null, properties: props.map(p => p.key) } };
}

// ── One fact by its key (forms round 2, 15 Nov 2026) ─────────────────────────────────────────
// What a plan step's {{fact:<key>}} or {{fact:<key>@<house>}} reads. Without a house: the FIRST scope that
// holds the key, in this order: the one house (only when the form names exactly one), the owner, general.
// A form naming two or more houses must name the house for a key any of them holds. With a house: that
// house (one of the form's own), then the owner, then general. Own keys only. Returns
// { value, scope, ref, label, source, date, expired }, or { refused, code } with a plain reason. A key or a
// value that reads as a declaration is refused (the store refuses them anyway: this is the belt).
function resolveFact(store, { owner, properties = [], key, at, today = todayLondon(), allowExpired = false } = {}) {
  const no = (code, refused) => ({ refused, code });
  const k = String(key || '').trim();
  if (!FACT_KEY_RE.test(k) || RESERVED_KEYS.has(k)) return no('key', `"${k}" is not a fact key (lower case, digits and hyphens)`);
  const dec = declarationIn(k);
  if (dec) return no('declaration', `"${dec}" is a declaration topic, and ${DECLARATION_HELP}`);
  const props = [];
  for (const ref of properties || []) {
    const p = findProperty(store, ref);
    if (!p) return no('property', `${ref} is not in the facts file`);
    if (!props.some(x => x.key === p.key)) props.push(p);
  }
  let o = null;
  if (owner) { o = findOwner(store, owner); if (!o) return no('owner', `${owner} is not in the facts file`); }
  else {
    const keys = [...new Set(props.map(p => p.owner).filter(Boolean))];
    if (keys.length === 1 && props.every(p => p.owner === keys[0])) o = findOwner(store, keys[0]);
  }
  let house = null;
  if (at !== undefined && at !== null && at !== '') {
    const p = findProperty(store, at);
    house = p && props.find(x => x.key === p.key);
    if (!house) return no('at', `"${at}" is not one of the houses this form names`);
  } else if (props.length === 1) house = props[0];
  else if (props.length > 1) {
    const holders = props.filter(p => own(p.facts, k));
    if (holders.length) return no('ambiguous', `"${k}" is held for a house and this form names ${props.length} houses: name the house, as {{fact:${k}@<house>}}`);
  }
  const order = [];
  if (house) order.push(['property', house.key, house.facts]);
  if (o) order.push(['owner', o.key, o.facts]);
  order.push(['general', null, ((store && store.general) || {}).facts]);
  for (const [scope, ref, facts] of order) {
    if (!own(facts, k) || !isObj(facts[k])) continue;
    const f = facts[k];
    const label = labelOf(scope, k, f);
    // Before the date: an out-of-date blanket gas answer is refused as gas, never sent back to be renewed.
    const gas = scope !== 'property' && gasIn(scope, k, label, f.value);
    if (gas) return no('gas', `"${gas}" is a gas answer, and ${GAS_HELP}`);
    const expired = isExpired(scope, k, f, today);
    // The live window may run an approved plan on a fact gone stale since, never a gas safety answer: a lapsed
    // certificate is not a current one, so the question stops for him.
    if (expired && (!allowExpired || gasSafetyFact(k, label, f.value))) return no('expired', `"${label}" (${k}) is out of date: dated ${f.date}${f.until ? `, good until ${f.until}` : ''}`);
    const decValue = declarationIn(label) || declarationInValue(f.value);
    if (decValue) return no('declaration', `"${decValue}" is a declaration topic, and ${DECLARATION_HELP}`);
    return { value: f.value, scope, ref, label, source: f.source, date: f.date, expired };
  }
  return no('unknown', `the fact ${k} is not on file`);
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────
function applySetFact(store, args) {
  const { scope, ref, key } = args || {};
  if (!['general', 'owner', 'property'].includes(scope)) throw refusal(`scope must be general, owner or property, got "${scope}"`);
  if (!FACT_KEY_RE.test(String(key || ''))) throw refusal(`"${key}" is not a fact key (lower case, digits and hyphens)`);
  if (RESERVED_KEYS.has(String(key)) || RESERVED_KEYS.has(String(ref))) throw refusal(`"${RESERVED_KEYS.has(String(key)) ? key : ref}" is a reserved name, never a fact key or a ref`);
  for (const f of ['value', 'source', 'date']) {
    if (typeof args[f] !== 'string' || !args[f].trim()) throw refusal(`a fact needs its ${f}${f === 'source' ? ' (where it came from)' : ''}: none was given for "${key}"`);
  }
  if (!validDate(args.date)) throw refusal(`"${args.date}" is not a date (YYYY-MM-DD)`);
  if (isFuture(args.date)) throw refusal(`"${args.date}" is in the future: a fact is dated the day it was given. Nothing was stored.`);
  if (args.until !== undefined && args.until !== null && !validDate(args.until)) throw refusal(`"until" must be a date (YYYY-MM-DD), got "${args.until}"`);
  if (!schemaEntry(scope, key) && !String(args.label || '').trim()) throw refusal(`"${key}" is not in the schema, so it needs its own --label`);
  const dec = declarationIn(args.label || labelOf(scope, key, null), key) || declarationInValue(args.value);
  if (dec) throw refusal(`refused: "${dec}" is a declaration topic, and ${DECLARATION_HELP}. Nothing was stored.`);
  const gas = gasProblem(scope, key, args.label || labelOf(scope, key, null), args.value, args.until || undefined);
  if (gas) throw refusal(`refused: ${gas}. Nothing was stored.`);
  let holder;
  if (scope === 'general') holder = store.general;
  else if (scope === 'owner') {
    const o = findOwner(store, ref);
    if (!o) throw refusal(`owner "${ref}" is not in the facts file: add it with node scripts/form-facts.js add-owner`);
    holder = store.owners[o.key];
  } else {
    const p = findProperty(store, ref);
    if (!p) throw refusal(`property "${ref}" is not in the facts file: add it with node scripts/form-facts.js add-property`);
    holder = store.properties[p.key];
  }
  holder.facts = holder.facts || {};
  const old = own(holder.facts, key) ? holder.facts[key] : null;
  const fact = { value: args.value.trim(), source: args.source.trim(), date: args.date };
  if (args.label && String(args.label).trim()) fact.label = String(args.label).trim();
  if (args.until) fact.until = args.until;
  if (old) {
    const prev = { value: old.value, source: old.source, date: old.date };
    if (old.until) prev.until = old.until;
    fact.was = [prev].concat(old.was || []).slice(0, WAS_MAX);
  }
  holder.facts[key] = fact;
  return fact;
}

function applyAddOwner(store, { key, name } = {}) {
  if (!REF_KEY_RE.test(String(key || ''))) throw refusal(`"${key}" is not a valid owner key (letters, digits and hyphens)`);
  if (RESERVED_KEYS.has(String(key))) throw refusal(`"${key}" is a reserved name, never an owner key`);
  if (!String(name || '').trim()) throw refusal(`owner "${key}" needs a name`);
  const was = own(store.owners, key) ? store.owners[key] : {};
  store.owners[key] = Object.assign({}, was, { name: String(name).trim(), facts: was.facts || {} });
  return store.owners[key];
}

function applyAddProperty(store, { key, address, town, postcode, owner } = {}) {
  if (!REF_KEY_RE.test(String(key || ''))) throw refusal(`"${key}" is not a valid property key (letters, digits and hyphens)`);
  if (RESERVED_KEYS.has(String(key))) throw refusal(`"${key}" is a reserved name, never a property key`);
  if (!String(address || '').trim()) throw refusal(`property "${key}" needs the first line of its address`);
  if (TAG_BREAK_RE.test(`${address}${postcode || ''}`)) throw refusal(`property "${key}": write the address and postcode without a colon or a square bracket (they would break its fact lines)`);
  if (owner && !own(store.owners, owner)) throw refusal(`owner "${owner}" is not in the facts file: add it first with node scripts/form-facts.js add-owner`);
  const was = own(store.properties, key) ? store.properties[key] : {};
  store.properties[key] = Object.assign({}, was, {
    address: String(address).trim(), town: String(town || was.town || '').trim(), postcode: String(postcode || was.postcode || '').trim(),
    owner: owner || was.owner || null, facts: was.facts || {},
  });
  return store.properties[key];
}

// The lock: a folder made atomically beside the file, held for one whole load-change-write.
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (e2) { continue; }   // released meanwhile: try again
      if (age > LOCK_STALE_MS) {
        // A dead writer's debris. Renamed away first: only one of two waiters wins the rename, so the
        // loser can never remove the lock the winner goes on to take.
        const gone = `${lock}.stale.${process.pid}.${Date.now()}`;
        try { fs.renameSync(lock, gone); fs.rmSync(gone, { recursive: true, force: true }); } catch (e3) { if (e3.code !== 'ENOENT') throw e3; }
        continue;
      }
      if (Date.now() > until) throw refusal(`the facts file is locked by another writer (${lock}); nothing was stored. Try again, or remove ${lock} if no writer is running.`);
      sleepMs(LOCK_RETRY_MS);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
const withStore = (file, fn) => withLock(file, () => { const s = loadStore(file); const r = fn(s); writeStore(s, file); return r; });
const setFact = (args, file = defaultFile()) => withStore(file, s => applySetFact(s, args));
const addOwner = (args, file = defaultFile()) => withStore(file, s => applyAddOwner(s, args));
const addProperty = (args, file = defaultFile()) => withStore(file, s => applyAddProperty(s, args));

// ── What Kevin answered in his own window (forms round 2, 15 Nov 2026; cut down by review R1) ────
// A RECORD for the agent, never a fact and never read by a form. When the robot stops mid-form for a question
// no fact answers, Kevin answers it in his "Your turn" window; agent-browser.js records that answer here, in
// "captured", with a box the robot filled that he changed ("was": a stored fact is then wrong). After his window
// the agent reads them (`node scripts/form-facts.js captured --task <id>`) and stores each real fact with `set`
// and its source. Each entry: { site, path, owner, properties, task, date, question, kind, index, answer, was? },
// index being the item's position on the page. Entries are appended, never merged (two "First name" boxes are
// two entries); at most 500, oldest dropped. Never recorded, checked here as well as by the caller: a
// declaration, a loss, anything on the never list, a private value (card, bank, password, code, identity number,
// verification), a long number, a 4 to 8 digit number that is not a year, sum, count or postcode, an empty
// question, or an answer over 200 characters. A bad entry in a hand-edited file is dropped on load, never a
// reason the facts cannot be read.
const CAPTURED_MAX = 500;
const CAPTURED_ANSWER_MAX = 200;
const SITE_RE = /^(?:[a-z0-9][a-z0-9.-]*|\[[0-9a-f:]+\])$/;
const CAPTURED_KINDS = new Set(['text', 'number', 'date', 'email', 'tel', 'url', 'search', 'combobox', 'select', 'radio', 'checkbox']);
// The questions a short number may answer: a year, a sum, a count, a postcode.
const NUMBER_QUESTION_RE = /\b(year|built|purchased|sum|cost|value|rent|postcode|storeys|bedrooms|bathrooms|rooms|floors|people|tenants|occupants)\b/i;
// The same list less rent, value and sum: what still makes a number fair game when the question also says account or reference.
const NUMBER_COUNT_RE = /\b(year|built|purchased|cost|postcode|storeys|bedrooms|bathrooms|rooms|floors|people|tenants|occupants)\b/i;
const squashSpace = t => String(t === undefined || t === null ? '' : t).replace(/\s+/g, ' ').trim();
// Identity and payment wording the shared private list does not hold (review round 3), capture only.
const CAPTURE_PRIVATE_RE = /\b(ni|national insurance|utr|taxpayer|tax reference|licen[cs]e|cv[cv]?\d?|\d[- ]digits?|digits on|expir\w*|mm ?\/ ?yy|name on the (?:card|account)|reference(?: number)?|nhs)\b/i;
// Why this question and answer may never be recorded, or ''. Total: anything it cannot read is a refusal.
function capturedRefusal(entry) {
  try { return capturedRefusalOf(entry || {}); } catch (e) { return `it cannot be read (${String(e.message || e).slice(0, 80)})`; }
}
function capturedRefusalOf({ question, answer, options = [], was }) {
  if (options !== undefined && options !== null && (!Array.isArray(options) || !options.every(o => typeof o === 'string' || (isObj(o) && typeof o.label === 'string')))) return 'its options are not a list of words';
  for (const v of [question, answer, was]) if (v !== undefined && v !== null && typeof v !== 'string') return 'a question, answer or "was" that is not text';
  options = options || [];
  const q = squashSpace(question), a = squashSpace(answer);
  if (!q) return 'it has no question';
  if (!a) return 'it has no answer';
  if (a.length > CAPTURED_ANSWER_MAX) return `the answer is longer than ${CAPTURED_ANSWER_MAX} characters`;
  const words = [q].concat((options || []).map(o => (o && typeof o === 'object' ? o.label : o)), [a, was]).map(squashSpace).join(' | ');
  const priv = words.match(PRIVATE_QUESTION_RE) || words.match(CAPTURE_PRIVATE_RE);
  if (priv) return `"${priv[0]}" is a private detail`;
  // A sum, rent or value is a number only when the question is not about an account or a reference.
  const numberQuestion = NUMBER_QUESTION_RE.test(q) && !(/\b(account|reference)\b/i.test(q) && !NUMBER_COUNT_RE.test(q));
  for (const v of [a, was]) {
    const t = squashSpace(v);
    if (t.replace(/\D/g, '').length >= 9) return 'the answer holds 9 or more digits (a card, account or reference number, perhaps)';
    if (/^\d[\d -]*\d$/.test(t) && /^\d{4,8}$/.test(t.replace(/[ -]/g, '')) && !numberQuestion) return 'a 4 to 8 digit number that is not a year, sum, count or postcode (a code or an account number, perhaps)';
  }
  const hit = declarationIn(words) || (words.match(NEARBY_DECLARATION_RE) || words.match(NEVER_ROBOT_RE) || words.match(CAPTURE_LOSS_RE) || [''])[0];
  if (hit) return `"${hit}" is a declaration, a loss or on the never list, which is Kevin's alone`;
  return '';
}
const propsKey = list => [...new Set((list || []).map(String))].sort();

const CAPTURED_FIELDS = new Set(['site', 'path', 'owner', 'properties', 'task', 'date', 'question', 'kind', 'index', 'answer', 'was', 'options']);
// Total (review round 3): never throws; an entry not exactly the expected shape is a problem.
function capturedProblems(where, c) {
  try { return capturedProblemsOf(where, c); } catch (e) { return [`${where}: cannot be read (${String(e.message || e).slice(0, 80)})`]; }
}
function capturedProblemsOf(where, c) {
  if (!isObj(c)) return [`${where}: not an entry`];
  const out = [];
  const extra = Object.keys(c).filter(k => !CAPTURED_FIELDS.has(k));
  if (extra.length) out.push(`${where}: unexpected fields ${extra.slice(0, 3).join(', ')}`);
  if (c.task !== undefined && c.task !== null && typeof c.task !== 'string') out.push(`${where}: "task" is not text`);
  if (c.options !== undefined && (!Array.isArray(c.options) || !c.options.every(o => typeof o === 'string'))) out.push(`${where}: "options" is not a list of words`);
  if (!SITE_RE.test(String(c.site || ''))) out.push(`${where}: no site (the page's host, lower case)`);
  if (typeof c.path !== 'string' || !c.path.startsWith('/')) out.push(`${where}: no path`);
  if (c.owner !== null && c.owner !== undefined && typeof c.owner !== 'string') out.push(`${where}: "owner" is not a key`);
  if (!Array.isArray(c.properties) || !c.properties.every(p => typeof p === 'string')) out.push(`${where}: "properties" is not a list of keys`);
  else if (!c.owner && !c.properties.length) out.push(`${where}: whose form it was is not known (no owner and no house)`);
  if (typeof c.question !== 'string' || typeof c.answer !== 'string') out.push(`${where}: no question or answer`);
  if (!CAPTURED_KINDS.has(c.kind)) out.push(`${where}: no kind`);
  if (!Number.isInteger(c.index) || c.index < 0) out.push(`${where}: no index`);
  if (!validDate(c.date)) out.push(`${where}: no date or a bad date (YYYY-MM-DD)`);
  if (c.was !== undefined && typeof c.was !== 'string') out.push(`${where}: "was" is not text`);
  const why = capturedRefusal(c);
  if (why) out.push(`${where}: never recorded: ${why}`);
  return out;
}
// The entries a store may hold, and how many were dropped (loadStore and check).
function splitCaptured(list) {
  if (!Array.isArray(list)) return { kept: [], dropped: list === undefined ? 0 : 1 };
  const kept = list.filter((c, i) => !capturedProblems(`captured[${i}]`, c).length);
  return { kept, dropped: list.length - kept.length };
}

function applyAddCaptured(store, e = {}) {
  if (!isObj(e)) throw refusal('not an entry. Nothing was stored.');
  const site = String(e.site || '').trim().toLowerCase();
  if (!SITE_RE.test(site)) throw refusal(`"${e.site}" is not a site (the page's host, lower case). Nothing was stored.`);
  const owner = e.owner ? String(e.owner) : null;
  const properties = propsKey(e.properties);
  if (!owner && !properties.length) throw refusal('whose form it was is not known (no owner and no house). Nothing was stored.');
  const why = capturedRefusal(e);
  if (why) throw refusal(`refused: ${why}. Nothing was stored.`);
  const date = e.date || todayLondon();
  if (!validDate(date) || isFuture(date)) throw refusal(`"${date}" is not today or earlier (YYYY-MM-DD). Nothing was stored.`);
  const c = { site, path: String(e.path || '/'), owner, properties, task: e.task ? String(e.task) : null, date,
    question: squashSpace(e.question), kind: String(e.kind || ''), index: Number(e.index), answer: squashSpace(e.answer) };
  if (e.was !== undefined && e.was !== null && squashSpace(e.was)) c.was = squashSpace(e.was);
  const bad = capturedProblems('the entry', c);
  if (bad.length) throw refusal(`refused: ${bad[0]}. Nothing was stored.`);
  // Appended, never merged: two boxes with the same question are two answers.
  store.captured = (store.captured || []).concat([c]).slice(-CAPTURED_MAX);
  return c;
}
const addCaptured = (args, file = defaultFile()) => withStore(file, s => applyAddCaptured(s, args));
// Several answers under one lock and one write. A refused entry is listed and the rest still stored.
function addCapturedMany(list, file = defaultFile()) {
  return withStore(file, s => {
    const stored = [], refused = [];
    for (const e of list || []) {
      try { stored.push(applyAddCaptured(s, e)); } catch (err) {
        if (!err.refusal) throw err;
        refused.push({ question: squashSpace(e && e.question).slice(0, 120), why: err.message });
      }
    }
    return { stored, refused };
  });
}
// How many recorded answers are on file for this owner or any of these houses (the dry run's count).
function capturedOnFile(store, { owner, properties = [] } = {}) {
  const props = new Set((properties || []).map(String));
  return ((store && store.captured) || []).filter(c => (owner && c.owner === owner) || (c.properties || []).some(p => props.has(p))).length;
}

// Plan lines against stored lines: the same label, a different value. Labels are compared with any
// "[house]" tag taken off. Two tagged lines are compared only when the tags name the same house; a plan
// line with no tag is compared with every stored line of that bare label.
function conflicts(planLines, storeLines) {
  const split = l => {
    const s = String(l); const i = s.indexOf(':');
    if (i < 0) return null;
    const head = s.slice(0, i);
    const tags = head.match(/\[[^\]]*\]/g);
    return { label: head.trim(), key: lineKey(head.replace(/\[[^\]]*\]/g, ' ')), tag: tags ? lineKey(tags[tags.length - 1].slice(1, -1)) : null, value: lineKey(s.slice(i + 1)) };
  };
  const out = [];
  for (const p of planLines || []) {
    const a = split(p);
    if (!a || !a.key) continue;
    for (const st of storeLines || []) {
      const b = split(st);
      if (!b || b.key !== a.key || b.value === a.value) continue;
      if (a.tag !== null && b.tag !== null && a.tag !== b.tag) continue;
      out.push({ label: a.label, plan: String(p), stored: String(st) });
    }
  }
  return out;
}

// ── The command line ───────────────────────────────────────────────────────────────────────────
function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (k === 'property') (out.property = out.property || []).push(v);
    else out[k] = v;
  }
  return out;
}
const str = v => (v === true || v === undefined ? undefined : String(v));

function countFacts(store, today) {
  let facts = 0, withoutSource = 0, expired = 0;
  const each = (scope, obj) => {
    for (const [k, f] of Object.entries(obj || {})) {
      facts++;
      if (!isObj(f) || !String(f.source || '').trim()) withoutSource++;
      else if (validDate(f.date) && isExpired(scope, k, f, today)) expired++;
    }
  };
  each('general', ((store.general || {}).facts));
  for (const o of Object.values(store.owners || {})) each('owner', o && o.facts);
  for (const p of Object.values(store.properties || {})) each('property', p && p.facts);
  return { facts, withoutSource, expired };
}

function runImport(spec, file) {
  return withLock(file, () => importLocked(spec, file));
}
function importLocked(spec, file) {
  const store = loadStore(file);
  const refused = [];
  let owners = 0, properties = 0, facts = 0;
  const tryIt = (what, fn) => { try { fn(); return true; } catch (e) { refused.push(`${what}: ${e.message}`); return false; } };
  for (const o of spec.owners || []) if (tryIt(`owner ${o && o.key}`, () => applyAddOwner(store, o))) owners++;
  for (const p of spec.properties || []) if (tryIt(`property ${p && p.key}`, () => applyAddProperty(store, p))) properties++;
  for (const f of spec.facts || []) if (tryIt(`fact ${f && f.scope}/${f && f.ref}/${f && f.key}`, () => applySetFact(store, f))) facts++;
  if (refused.length) return { written: false, refused };
  writeStore(store, file);
  return { written: true, owners, properties, facts };
}

function cli(argv) {
  const a = argsOf(argv);
  const cmd = a._[0];
  const file = defaultFile();
  const print = o => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  if (cmd === 'lines') {
    const r = linesFor(loadStore(file), { owner: str(a.owner), properties: (a.property || []).map(String) });
    const bySource = new Map(r.used.map(u => [u.line, u]));
    const lines = a['with-source'] ? r.lines.map(l => (bySource.get(l) ? `${l}   [${bySource.get(l).source}, ${bySource.get(l).date}]` : l)) : r.lines;
    print({ file, lines, expired: r.expired, missing: r.missing, problems: r.problems });
    if (r.problems.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'set') {
    const fact = setFact({ scope: str(a.scope), ref: str(a.ref), key: str(a.key), value: str(a.value), source: str(a.source),
      date: str(a.date) || todayLondon(), label: str(a.label), until: str(a.until) }, file);
    print({ file, stored: fact });
    return;
  }
  if (cmd === 'add-property') {
    print({ file, property: addProperty({ key: str(a.key), address: str(a.address), town: str(a.town), postcode: str(a.postcode), owner: str(a.owner) }, file) });
    return;
  }
  if (cmd === 'add-owner') {
    print({ file, owner: addOwner({ key: str(a.key), name: str(a.name) }, file) });
    return;
  }
  if (cmd === 'import') {
    const src = str(a.file);
    if (!src) throw refusal('--file is required');
    let spec;
    try { spec = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { throw refusal(`the import file ${src} cannot be read: ${e.message}`); }
    const r = runImport(spec, file);
    print(Object.assign({ file }, r));
    if (!r.written) process.exitCode = 1;
    return;
  }
  if (cmd === 'captured') {
    // The answers Kevin gave in his own window, with the answers: this is the private file.
    const store = loadStore(file);
    const site = str(a.site), owner = str(a.owner);
    let ownerKey = null;
    if (owner) { const o = findOwner(store, owner); if (!o) throw refusal(`owner "${owner}" is not in the facts file`); ownerKey = o.key; }
    const taskId = str(a.task);
    const list = (store.captured || []).filter(c => (!site || c.site === site.toLowerCase()) && (!ownerKey || c.owner === ownerKey) && (!taskId || c.task === taskId));
    print({ file, captured: list });
    return;
  }
  if (cmd === 'check') {
    let store = null;
    const problems = [];
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') store = emptyStore(); else problems.push(`cannot be read: ${e.message}`);
    }
    const split = store && isObj(store) ? splitCaptured(store.captured) : { kept: [], dropped: 0 };
    if (store && isObj(store) && store.captured !== undefined) store.captured = split.kept;
    if (store) problems.push(...validateStore(store));
    const ok = store && isObj(store);
    const c = ok ? countFacts(store, todayLondon()) : { facts: 0, withoutSource: 0, expired: 0 };
    print({ file, owners: ok ? Object.keys(store.owners || {}).length : 0, properties: ok ? Object.keys(store.properties || {}).length : 0,
      facts: c.facts, withoutSource: c.withoutSource, expired: c.expired, captured: ok && Array.isArray(store.captured) ? store.captured.length : 0, capturedDropped: split.dropped, problems });
    if (problems.length) process.exitCode = 1;
    return;
  }
  process.stderr.write(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => /^\/\/ {2,}node /.test(l)).map(l => l.slice(3)).join('\n') + '\n');
  process.exitCode = 2;
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (e) {
    process.stderr.write((e && e.refusal ? e.message : `FORM FACTS ERROR: ${(e && e.stack) || e}`) + '\n');
    process.exit(1);
  }
}

module.exports = { loadStore, validateStore, writeStore, findProperty, findOwner, linesFor, resolveFact, setFact, addProperty, addOwner, conflicts,
  addCaptured, addCapturedMany, capturedOnFile, capturedRefusal, CAPTURED_MAX,
  applySetFact, applyAddOwner, applyAddProperty, runImport, todayLondon, defaultFile, SCHEMA, DEFAULT_DAYS };
