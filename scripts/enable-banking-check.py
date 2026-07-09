#!/usr/bin/env python3
"""
Enable Banking — coverage check (the GATE before any bank-feed build).

Signs a JWT with the application's private key and calls GET /aspsps?country=GB,
then reports whether Tide / Santander / Zempler(Cashplus) are available as
connectors for the UK. Read-only: lists banks, touches no account data.

Env (set as GitHub Actions secrets):
  ENABLE_BANKING_APP_ID  — the Application ID (the JWT `kid`; not secret on its own)
  ENABLE_BANKING_KEY     — the full contents of the {app-id}.pem private key

No account is accessed here; this only enumerates supported banks.
"""
import os, sys, time, json, urllib.request, urllib.error

try:
    import jwt  # PyJWT
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.hazmat.primitives.asymmetric import rsa
except ImportError:
    sys.exit("Missing deps — run: pip install 'pyjwt[crypto]' cryptography")

BASE = "https://api.enablebanking.com"
TARGETS = ["tide", "santander", "zempler", "cashplus"]  # banks we need for the migration


def make_jwt(app_id: str, key_pem: str) -> str:
    priv = load_pem_private_key(key_pem.encode(), password=None)
    alg = "RS256" if isinstance(priv, rsa.RSAPrivateKey) else "ES256"  # RSA vs EC key
    now = int(time.time())
    return jwt.encode(
        {"iss": "enablebanking.com", "aud": "api.enablebanking.com",
         "iat": now, "exp": now + 3600},
        key_pem, algorithm=alg, headers={"typ": "JWT", "kid": app_id},
    )


def get(path: str, token: str):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    app_id = os.environ.get("ENABLE_BANKING_APP_ID", "").strip()
    key_pem = os.environ.get("ENABLE_BANKING_KEY", "")
    if not app_id or not key_pem:
        sys.exit("Set ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY (see docstring).")

    token = make_jwt(app_id, key_pem)
    try:
        data = get("/aspsps?country=GB", token)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"API error {e.code}: {body}\n"
                 f"(401/403 usually means the key type / kid / clock is off; "
                 f"check the app id and that the .pem matches this application.)")

    banks = data.get("aspsps", [])
    names = sorted({b.get("name", "?") for b in banks})
    print(f"Enable Banking lists {len(names)} bank connectors for GB.\n")

    print("=== Coverage for the accounts we need ===")
    all_found = True
    for t in TARGETS:
        hits = [b for b in banks if t in b.get("name", "").lower()]
        if hits:
            for b in hits:
                psu = "/".join(b.get("psu_types", []) or ["?"])
                mcv = b.get("maximum_consent_validity")
                days = f"{mcv // 86400}d" if isinstance(mcv, int) else "?"
                print(f"  ✅ {b['name']:<34} psu={psu:<16} max-consent={days}")
        else:
            print(f"  ❌ {t.capitalize():<34} NOT found")
            if t != "cashplus":  # cashplus == zempler; only flag once
                all_found = False

    print("\n=== All GB connectors (search for your exact bank names) ===")
    for n in names:
        print("   " + n)

    print("\n" + ("RESULT: all required banks present — safe to build the direct feed."
                  if all_found else
                  "RESULT: at least one required bank is missing — review before building "
                  "(Zempler may appear as 'Cashplus'; a business account may need psu_type=business)."))


if __name__ == "__main__":
    main()
