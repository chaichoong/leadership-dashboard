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
//
// USAGE (prints JSON; exits 1 with a plain message on a refusal)
//   node scripts/form-facts.js lines --owner <ref> [--property <ref>]... [--with-source]
//   node scripts/form-facts.js set --scope property|owner|general [--ref <ref>] --key <key> --value <v> --source <s>
//        [--date YYYY-MM-DD] [--label <l>] [--until YYYY-MM-DD]
//   node scripts/form-facts.js add-property --key <k> --address <a> --town <t> --postcode <p> [--owner <owner-key>]
//   node scripts/form-facts.js add-owner --key <k> --name <n>
//   node scripts/form-facts.js import --file <json>
//   node scripts/form-facts.js check
//
// Two writers never lose each other's write: every load-change-write holds <file>.lock (a folder, made
// atomically) for its whole length. A lock older than 60 seconds is debris from a dead writer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECLARATION_TOPIC_RE } = require('./declaration-words');
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
  return out;
}

function validateStore(store) {
  const out = [];
  if (!isObj(store)) return ['the file is not a JSON object'];
  if (store.general !== undefined && !isObj(store.general)) out.push('"general" is not an object');
  if (store.owners !== undefined && !isObj(store.owners)) out.push('"owners" is not an object');
  if (store.properties !== undefined && !isObj(store.properties)) out.push('"properties" is not an object');
  if (out.length) return out;
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
  if (cmd === 'check') {
    let store = null;
    const problems = [];
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') store = emptyStore(); else problems.push(`cannot be read: ${e.message}`);
    }
    if (store) problems.push(...validateStore(store));
    const ok = store && isObj(store);
    const c = ok ? countFacts(store, todayLondon()) : { facts: 0, withoutSource: 0, expired: 0 };
    print({ file, owners: ok ? Object.keys(store.owners || {}).length : 0, properties: ok ? Object.keys(store.properties || {}).length : 0,
      facts: c.facts, withoutSource: c.withoutSource, expired: c.expired, problems });
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

module.exports = { loadStore, validateStore, writeStore, findProperty, findOwner, linesFor, setFact, addProperty, addOwner, conflicts,
  applySetFact, applyAddOwner, applyAddProperty, runImport, todayLondon, defaultFile, SCHEMA, DEFAULT_DAYS };
