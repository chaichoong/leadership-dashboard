#!/usr/bin/env python3
"""eBay item search for the sourcing process, through eBay's own Browse API (approved build recDPkv36UXe8QDD9).

WHY THIS EXISTS
---------------
The Customer Service agent prices products for a SOURCING card. eBay is one of the obvious
second-hand sellers, and the robot cannot read it: on 11 Nov 2026 the robot browser and the page
fetch route both came back "Error Page | eBay", "Pardon our interruption" and HTTP 403. A bot block
is never worked round, so eBay sat on the card as NOT CHECKED. eBay publishes a proper route for
exactly this read, the Browse API, and this is it.

WHAT IT DOES
------------
One read, nothing else. It asks eBay for an application token with the two keys in ~/.config/od
(client credentials), searches `item_summary`, and prints the title, price, postage, location and
link of each result. UK marketplace only. A price cap and a collection radius around a postcode are
optional filters, passed to eBay rather than judged here.

It never signs in as Kevin, never bids, never buys and never messages a seller: the application
token carries the public `api_scope` only, which reads listings.

THE RULE THAT MATTERS MOST
--------------------------
**A failure says NOT CHECKED, never "no results".** A blocked page's silence put on a card as
"nothing found" is the mistake this build exists to end (sourcing session, 11 Nov 2026). So:
  - no keys, a refused token, an unreachable service, an answer that is not the shape eBay
    documents -> "NOT CHECKED: <why>" on stderr, exit 2, and nothing on stdout to mistake for a
    result;
  - a search eBay answered with an empty list -> "0 results" and exit 0. That is a real answer.

The key values are never printed, logged or put on a command line: they are read from the two 0600
files and sent only in the token request's own header.

Usage:
  python3 scripts/ebay-search.py --q "washing machine" [--max-price 150] [--min-price 20]
        [--postcode CB9 8PU] [--radius 25] [--condition used|new] [--limit 10] [--json]
  python3 scripts/ebay-search.py selftest
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

CONFIG_DIR = os.path.expanduser("~/.config/od")
APP_ID_FILE = "ebay_app_id"          # the public App ID (client id). Not a secret, kept beside its pair.
CERT_ID_FILE = "ebay_cert_id"        # the Cert ID (client secret). Kevin pastes this one, once.
# Overridable so a test can stand a stub server in eBay's place. Never pointed anywhere else in production.
API_BASE = os.environ.get("EBAY_API_BASE", "https://api.ebay.com")
MARKETPLACE = "EBAY_GB"              # UK only: the plan says UK, and a US price on a UK card is wrong
SCOPE = "https://api.ebay.com/oauth/api_scope"      # the public read scope, the narrowest eBay offers
HTTP_TIMEOUT = 25
LIMIT_MAX = 50                       # eBay's own ceiling for item_summary/search
RADIUS_UNIT = "mi"
# A postcode that eBay will take as a pickup point. Loose on spacing, strict on shape, so a town
# name typed into --postcode is refused here rather than silently ignored by eBay.
POSTCODE_RE = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$", re.I)


class NotChecked(Exception):
    """Something could not be read. The caller prints NOT CHECKED and exits 2, never "no results"."""


def read_key(name, config_dir=CONFIG_DIR):
    try:
        with open(os.path.join(config_dir, name), encoding="utf-8") as fh:
            v = fh.read().strip()
    except OSError:
        raise NotChecked("the eBay key file %s is not there yet (Kevin pastes it through Replace a key)" % name)
    if not v:
        raise NotChecked("the eBay key file %s is empty" % name)
    return v


def _request(url, headers=None, data=None, method=None):
    """(status, parsed body). The body is parsed JSON, or {} when there is none.

    No part of an error body is passed on except eBay's own short error id: an error body can quote
    the request, and the request carries the token.
    """
    req = urllib.request.Request(url, data=data, headers=dict(headers or {}, **{"User-Agent": "od-ebay-search"}),
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            raw = r.read() or b"{}"
            try:
                return r.status, json.loads(raw)
            except ValueError:
                raise NotChecked("eBay answered HTTP %d with something that is not JSON" % r.status)
    except urllib.error.HTTPError as e:
        code = ""
        try:
            body = json.loads(e.read() or b"{}")
            errs = body.get("errors") if isinstance(body, dict) else None
            if isinstance(errs, list) and errs and isinstance(errs[0], dict):
                code = str(errs[0].get("errorId") or "")
        except (ValueError, OSError):
            code = ""
        return e.code, {"errorId": code} if re.match(r"^\d{1,8}$", code) else {}
    except urllib.error.URLError as e:
        raise NotChecked("eBay could not be reached (%s)" % type(getattr(e, "reason", e)).__name__)
    except (ValueError, OSError) as e:
        # A header the library refused would put the token in the message: only the class name leaves here.
        raise NotChecked("the request to eBay could not be made (%s)" % type(e).__name__)


def token(config_dir=CONFIG_DIR):
    """An application token from the two keys. The keys never leave this function."""
    app_id, cert_id = read_key(APP_ID_FILE, config_dir), read_key(CERT_ID_FILE, config_dir)
    basic = base64.b64encode(("%s:%s" % (app_id, cert_id)).encode()).decode()
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "scope": SCOPE}).encode()
    status, body = _request(API_BASE + "/identity/v1/oauth2/token",
                            {"Authorization": "Basic " + basic,
                             "Content-Type": "application/x-www-form-urlencoded"}, data, "POST")
    if status in (400, 401, 403):
        raise NotChecked("eBay refused the keys (HTTP %d%s). Check the App ID and Cert ID in the key register."
                         % (status, (": error %s" % body["errorId"]) if body.get("errorId") else ""))
    if not (200 <= status < 300):
        raise NotChecked("eBay's token service answered HTTP %d, so the keys could not be judged" % status)
    tok = body.get("access_token")
    if not isinstance(tok, str) or not tok:
        raise NotChecked("eBay's answer carried no access_token")
    return tok


def filters(max_price=None, min_price=None, condition="", postcode="", radius=None):
    """eBay's `filter` list: UK sellers, UK delivery, a price band, and a collection radius."""
    out = ["itemLocationCountry:GB", "deliveryCountry:GB"]
    if max_price is not None or min_price is not None:
        lo = "" if min_price is None else ("%g" % min_price)
        hi = "" if max_price is None else ("%g" % max_price)
        out.append("price:[%s..%s]" % (lo, hi))
        out.append("priceCurrency:GBP")        # eBay refuses a price filter without its currency
    cond = {"new": "NEW", "used": "USED", "": ""}.get((condition or "").lower().strip(), None)
    if cond is None:
        raise NotChecked("--condition takes new or used, not %r" % condition)
    if cond:
        out.append("conditions:{%s}" % cond)
    if postcode:
        if not POSTCODE_RE.match(postcode.strip()):
            raise NotChecked("%r is not a UK postcode, so no collection radius was asked for" % postcode)
        out.append("pickupCountry:GB")
        out.append("pickupPostalCode:%s" % postcode.strip().upper())
        out.append("pickupRadius:%d" % int(radius or 25))
        out.append("pickupRadiusUnit:%s" % RADIUS_UNIT)
    return out


def money(m):
    """"£149.99" from eBay's {value, currency}, or "" when it did not say."""
    if not isinstance(m, dict):
        return ""
    v, cur = m.get("value"), (m.get("currency") or "")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return ""
    return ("£%.2f" % v) if cur == "GBP" else ("%.2f %s" % (v, cur) if cur else "%.2f" % v)


def postage(item):
    """"free", "£4.95", "collection only" or "not stated" — never a guess at nothing."""
    opts = item.get("shippingOptions")
    if not isinstance(opts, list) or not opts:
        return "not stated"
    first = opts[0] if isinstance(opts[0], dict) else {}
    if (first.get("shippingCostType") or "") == "CALCULATED" and not first.get("shippingCost"):
        return "not stated"
    cost = money(first.get("shippingCost"))
    if cost in ("£0.00",):
        return "free"
    if not cost:
        return "collection only" if (first.get("shippingCostType") or "") == "PICKUP" else "not stated"
    return cost


def place(item):
    loc = item.get("itemLocation")
    if not isinstance(loc, dict):
        return "not stated"
    bits = [loc.get(k) for k in ("city", "postalCode", "country") if loc.get(k)]
    return ", ".join(str(b) for b in bits) or "not stated"


def rows(body):
    """eBay's answer as our own rows. A body that is not the documented shape is NOT CHECKED."""
    if not isinstance(body, dict):
        raise NotChecked("eBay's answer was not an object")
    if "itemSummaries" not in body and "total" not in body:
        # The converse of "a wrong query still returns 200": no itemSummaries key and no total is an
        # error reply, and reading it as zero results is exactly the confident wrong answer this
        # tool exists to stop (CLAUDE.md, finding 20261104-phase-2-1187).
        raise NotChecked("eBay's answer carried neither itemSummaries nor total, so it is an error, not an empty result")
    items = body.get("itemSummaries")
    if items is None:
        items = []
    if not isinstance(items, list):
        raise NotChecked("eBay's itemSummaries was not a list")
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        out.append({"title": str(it.get("title") or "(no title)"),
                    "price": money(it.get("price")) or "not stated",
                    "postage": postage(it),
                    "condition": str(it.get("condition") or "not stated"),
                    "location": place(it),
                    "link": str(it.get("itemWebUrl") or "")})
    return out


def search(q, max_price=None, min_price=None, condition="", postcode="", radius=None, limit=10,
           config_dir=CONFIG_DIR):
    """The rows for one search. Raises NotChecked for anything that is not a real answer."""
    if not (q or "").strip():
        raise NotChecked("--q is required: say what to search for")
    limit = max(1, min(int(limit or 10), LIMIT_MAX))
    params = {"q": q.strip(), "limit": str(limit),
              "filter": ",".join(filters(max_price, min_price, condition, postcode, radius))}
    url = API_BASE + "/buy/browse/v1/item_summary/search?" + urllib.parse.urlencode(params)
    headers = {"Authorization": "Bearer " + token(config_dir),
               "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
               "Accept": "application/json"}
    if postcode:
        # Tells eBay where the buyer is, so its own distance and collection answers are from the
        # property, not from London.
        headers["X-EBAY-C-ENDUSERCTX"] = "contextualLocation=country%3DGB%2Czip%3D" + \
            urllib.parse.quote(postcode.strip().upper())
    status, body = _request(url, headers)
    if status in (401, 403):
        raise NotChecked("eBay refused the search (HTTP %d): the token did not carry the read scope" % status)
    if not (200 <= status < 300):
        raise NotChecked("eBay answered HTTP %d, so the search could not be judged" % status)
    return rows(body)


def as_text(found, q):
    if not found:
        return "0 results for %r on eBay UK. eBay answered: nothing matched." % q
    out = ["%d result%s for %r on eBay UK:" % (len(found), "" if len(found) == 1 else "s", q)]
    for r in found:
        out.append("- %s | %s | postage %s | %s | %s | %s"
                   % (r["title"], r["price"], r["postage"], r["condition"], r["location"], r["link"] or "no link"))
    return "\n".join(out)


def parse(argv):
    def val(flag, cast=str):
        if flag not in argv:
            return None
        i = argv.index(flag)
        if i + 1 >= len(argv):
            raise NotChecked("%s was given with nothing after it" % flag)
        try:
            return cast(argv[i + 1])
        except ValueError:
            raise NotChecked("%s does not take %r" % (flag, argv[i + 1]))
    return {"q": val("--q") or "", "max_price": val("--max-price", float), "min_price": val("--min-price", float),
            "condition": val("--condition") or "", "postcode": val("--postcode") or "",
            "radius": val("--radius", int), "limit": val("--limit", int) or 10,
            "json": "--json" in argv}


def selftest():
    """Proves the rules that matter, with no network: the filters, the shapes, and NOT CHECKED."""
    checks, failed = 0, []

    def ok(label, cond):
        nonlocal checks
        checks += 1
        if not cond:
            failed.append(label)

    f = filters(150, None, "used", "CB9 8PU", 25)
    ok("UK only", "itemLocationCountry:GB" in f and "deliveryCountry:GB" in f)
    ok("price cap carries its currency", "price:[..150]" in f and "priceCurrency:GBP" in f)
    ok("condition", "conditions:{USED}" in f)
    ok("collection near a postcode", "pickupPostalCode:CB9 8PU" in f and "pickupRadius:25" in f)
    ok("no price filter when no cap", not any(x.startswith("price:") for x in filters()))
    for bad in ("Haverhill", "CB9"):
        try:
            filters(postcode=bad)
            failed.append("a bad postcode was taken: %s" % bad)
        except NotChecked:
            pass
        checks += 1
    try:
        filters(condition="refurbished")
        failed.append("an unknown condition was taken")
    except NotChecked:
        pass
    checks += 1
    ok("money", money({"value": "149.99", "currency": "GBP"}) == "£149.99" and money(None) == "")
    ok("postage free", postage({"shippingOptions": [{"shippingCost": {"value": "0.0", "currency": "GBP"}}]}) == "free")
    ok("postage not stated", postage({}) == "not stated")
    ok("rows", rows({"total": 1, "itemSummaries": [{"title": "T", "price": {"value": "10", "currency": "GBP"},
                                                    "itemWebUrl": "https://www.ebay.co.uk/itm/1"}]})[0]["price"] == "£10.00")
    ok("zero results is an answer", rows({"total": 0, "itemSummaries": []}) == [])
    try:
        rows({"warnings": []})
        failed.append("an error body was read as zero results")
    except NotChecked:
        pass
    checks += 1
    ok("zero results never says NOT CHECKED", "NOT CHECKED" not in as_text([], "x") and "0 results" in as_text([], "x"))
    return {"checks": checks, "failed": failed}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "selftest":
        out = selftest()
        print("ebay-search selftest OK (%d checks)" % out["checks"] if not out["failed"]
              else "ebay-search selftest FAILED: " + "; ".join(out["failed"]))
        return 1 if out["failed"] else 0
    if not argv or "--help" in argv or "-h" in argv:
        print(__doc__)
        return 2
    try:
        a = parse(argv)
        found = search(a["q"], a["max_price"], a["min_price"], a["condition"], a["postcode"], a["radius"], a["limit"])
    except NotChecked as exc:
        sys.stderr.write("NOT CHECKED: %s\n" % exc)
        return 2
    if a["json"]:
        print(json.dumps({"query": a["q"], "marketplace": MARKETPLACE, "count": len(found), "results": found}, indent=1))
    else:
        print(as_text(found, a["q"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
