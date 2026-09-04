// The credential guard must refuse a Companies House authentication code field
// (4 Sep 2026). WebFiling signs in through GOV.UK One Login and each company's
// 6-character authentication code is the company's signature: Kevin enters it
// into his own account once and an agent never types it. The field is not
// type=password and its name does not say "password", so only the name regex
// can catch it. Reads the regex out of the source, like agent-browser-channel.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'scripts', 'agent-browser.js'), 'utf8');
const m = src.match(/const SECRET_NAME_RE = (\/.*\/i);/);
const re = new RegExp(m[1].slice(1, -2), 'i');

describe('agent-browser credential-name guard', () => {
  it('is present in the source', () => { expect(m).not.toBeNull(); });
  it.each(['authCode', 'authenticationCode', 'company-auth-code', 'auth_code', 'password', 'otpCode', 'security-code', 'cardNumber'])
    ('refuses %s', (name) => { expect(re.test(name)).toBe(true); });
  it.each(['companyNumber', 'site-search-text', 'email', 'madeUpToDate', 'author', 'authorised-signatory-name'])
    ('allows %s', (name) => { expect(re.test(name)).toBe(false); });
});
