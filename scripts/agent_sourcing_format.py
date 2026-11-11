#!/usr/bin/env python3
"""The SOURCING card contract, shared by the submit gate and the complete gate.

Kevin approved this shape on 11 Nov 2026. On 2 Nov 2026 a sourcing card for
four fridge freezers (task reck5ZY5MoXulxJz8) reached him with ten listing
links and a wall of text, and he had to vet every link himself. A sourcing
card now offers one pick per unit needed and two reserves, with the facts on
fixed lines, and `agent-dispatch.py submit` refuses anything else.

AGENT OUTPUT FORMAT (keys at the start of a line, any order, other card text
such as CHECKED:, the bold Approve line, TRACK RECORD, KEVIN ONLY and the
closing line may sit around them)

    SOURCING: <item> x <qty> for <property>
    BASELINE: <last buy on the preferred list: item, supplier, £price, date> | none on the list
    PICK: <name> | <new|second-hand> | £<full price with delivery and VAT> | <https link>
    RESERVE 1: <name> | <new|second-hand> | £<full price> | <https link>   (or: none found)
    RESERVE 2: <same>                                                     (or: none found)
    NEW FOR COMPARISON: <item> | £<full price> | <https link>             (or: not found: <why>)
    CASHBACK: <TopCashback rate or £, expected not guaranteed> | none offered | not checked: <why> | n/a
    PROVEN: <what the listing or page proves against the buying rules>
    NOT PROVEN: <what it does not prove> | nothing
    SAVING: <£ against the baseline, or against the new price> | no baseline
    PAY BY: <shop checkout | seller: bank transfer | seller: cash on collection>
    SEARCHED: <sites searched; and any site NOT CHECKED with why>
    SPEND: £<total> (one-off)

More than one unit: PICK 1:, PICK 2: ... up to the quantity.

Pure functions, no network. The SPEND pattern is a copy of SPEND_LINE_RE in
agent-dispatch.py (that file has a hyphen in its name and cannot be imported
here); tests/sourcing-card.test.js fails if the two ever differ.
"""

import re
from urllib.parse import urlsplit


class SourcingFormatError(ValueError):
    pass


# Must stay identical to SPEND_LINE_RE in scripts/agent-dispatch.py.
SPEND_LINE_RE = re.compile(
    r"^\s*SPEND:\s*£?\s*(?P<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*"
    r"(?P<recurring>(?:/|per\s+|a\s+|each\s+|every\s+)?"
    r"(?:month|week|year|quarter|annum|recurring|monthly|weekly|annually|yearly)\b)?",
    re.I | re.M)

# Written on the task's Notes by agent-dispatch.py submit when it accepts a sourcing card, so the
# close gate still fires after a later output on the same task drops the SOURCING line.
SOURCING_SUBMITTED_MARK = "SOURCING CARD SUBMITTED"

# One pattern for every key, read leniently (11 Nov 2026 review): spaces, a bullet (- * • >) and
# markdown bold may come before the key, and the colon may sit inside or outside the bold, so
# `**SOURCING:** x`, `- PICK: x`, `**PICK 2**: x` and `* **SPEND:** £70` read like the plain form.
# NOT PROVEN is listed before PROVEN so a line that starts "NOT PROVEN:" is never read as PROVEN.
_BOLD = r"(?:\*\*|__)?"
KEY_RE = re.compile(
    r"^\s*(?:[-*•>]\s*)*" + _BOLD + r"\s*"
    r"(?P<key>SOURCING|BASELINE|PICK(?:\s+(?P<picknum>\d+))?|RESERVE\s+(?P<resnum>\d+)"
    r"|NEW\s+FOR\s+COMPARISON|CASHBACK|NOT\s+PROVEN|PROVEN|SAVING|PAY\s+BY|SEARCHED|SPEND)"
    r"\s*" + _BOLD + r"\s*:\s*" + _BOLD + r"\s*(?P<value>.*?)\s*" + _BOLD + r"\s*$",
    re.I)

# The quantity is the first ` x <N> for ` on the SOURCING line, never a later size (160 x 230).
QTY_RE = re.compile(r"(?:^|\s)[x×]\s*(\d+)\s+for\b", re.I)
PRICE_RE = re.compile(r"^£\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)$")
LINK_RE = re.compile(r"^https?://\S+$", re.I)
URL_RE = re.compile(r"https?://[^\s<>()\[\]\"'`]+", re.I)
KINDS = ("new", "second-hand")

# Lines that must be present with something written after the colon.
REQUIRED_TEXT = ("BASELINE", "PROVEN", "NOT PROVEN", "SAVING", "PAY BY", "SEARCHED")

SHAPE = (
    "SOURCING: <item> x <qty> for <property>\n"
    "BASELINE: <last buy on the preferred list: item, supplier, £price, date> | none on the list\n"
    "PICK: <name> | <new|second-hand> | £<full price with delivery and VAT> | <https link>\n"
    "RESERVE 1: <name> | <new|second-hand> | £<full price> | <https link>   (or: RESERVE 1: none found)\n"
    "RESERVE 2: <same>   (or: RESERVE 2: none found)\n"
    "NEW FOR COMPARISON: <item> | £<full price> | <https link>   (or: NEW FOR COMPARISON: not found: <why>)\n"
    "CASHBACK: <TopCashback rate or £, expected not guaranteed> | none offered | not checked: <why> | n/a\n"
    "PROVEN: <what the listing or page proves against the buying rules>\n"
    "NOT PROVEN: <what it does not prove> | nothing\n"
    "SAVING: <£ against the baseline, or against the new price> | no baseline\n"
    "PAY BY: <shop checkout | seller: bank transfer | seller: cash on collection>\n"
    "SEARCHED: <sites searched, and any site NOT CHECKED with why>\n"
    "SPEND: £<total> (one-off)\n"
    "More than one unit: PICK 1:, PICK 2: ... up to the quantity."
)


def key_lines(output):
    """Every keyed line of the output as (KEY, value, match), through the one lenient
    reader. KEY is upper case with single spaces (PICK 2, RESERVE 1, NOT PROVEN)."""
    out = []
    for line in str(output or "").splitlines():
        m = KEY_RE.match(line)
        if m:
            out.append((" ".join(m.group("key").upper().split()), m.group("value"), m))
    return out


def is_sourcing(output):
    """True when a line of this output carries the SOURCING key (any case, bullets and bold allowed)."""
    return any(k == "SOURCING" for k, _v, _m in key_lines(output))


def spend_amount(output):
    """The amount on the first SPEND line read through the lenient reader, or None."""
    for key, value, _m in key_lines(output):
        if key == "SPEND":
            sm = SPEND_LINE_RE.match("SPEND: " + value)
            if sm:
                return float(sm.group("amount").replace(",", ""))
    return None


def _price(value, where):
    m = PRICE_RE.match(value.strip())
    if not m:
        raise SourcingFormatError(
            f"the price on {where} must be written as £ and a number, for example £75, got {value.strip()!r}")
    amount = float(m.group(1).replace(",", ""))
    if amount <= 0:
        raise SourcingFormatError(f"the price on {where} must be more than £0, got {value.strip()!r}")
    return amount


def _link(value, where):
    v = value.strip()
    if not LINK_RE.match(v):
        raise SourcingFormatError(
            f"the link on {where} must be one http or https address, got {v!r}")
    return v


def _item(value, where):
    """One PICK or RESERVE line in its four-field form."""
    parts = [p.strip() for p in value.split("|")]
    if len(parts) != 4:
        raise SourcingFormatError(
            f"{where} must have four parts split by ' | ': name | new or second-hand | £full price | link, "
            f"and it has {len(parts)}")
    name, kind, price, link = parts
    if not name:
        raise SourcingFormatError(f"{where} has no name in its first part")
    if kind.lower() not in KINDS:
        raise SourcingFormatError(f"the second part of {where} must be new or second-hand, got {kind!r}")
    return {"name": name, "kind": kind.lower(), "price": _price(price, where),
            "link": _link(link, where)}


# Links the cap never counts: the email thread, the task record and the cashback page are
# references, not things Kevin is asked to vet.
UNCOUNTED_HOSTS = ("mail.google.com", "airtable.com", "topcashback.co.uk")

# A marketplace ITEM page, the only kind of link the backstop reads as an offer to buy.
ITEM_PAGES = (("facebook.com", "/marketplace/item/"), ("gumtree.com", "/p/"),
              ("ebay.co.uk", "/itm/"), ("vinted.co.uk", "/items/"))


def _on(host, domain):
    return host == domain or host.endswith("." + domain)


def _split_url(url):
    """(host, path) with trailing punctuation, the query string and the fragment gone."""
    url = url.rstrip(".,;:!?*_")
    try:
        parts = urlsplit(url)
    except ValueError:
        return "", ""
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host, parts.path.rstrip("/")


def card_links(output):
    """The distinct links the cap counts, in first-seen order: every http(s) link except
    those on UNCOUNTED_HOSTS. The same page twice (another query string, a trailing
    slash or full stop) counts once."""
    seen = []
    for raw in URL_RE.findall(output or ""):
        host, path = _split_url(raw)
        if not host or any(_on(host, d) for d in UNCOUNTED_HOSTS):
            continue
        if host + path not in seen:
            seen.append(host + path)
    return seen


def item_links(output):
    """The distinct marketplace item links (facebook.com/marketplace/item/, gumtree.com/p/,
    ebay.co.uk/itm/, vinted.co.uk/items/, any subdomain). An order page, a post-an-advert
    page or a search is not an item."""
    seen = []
    for raw in URL_RE.findall(output or ""):
        host, path = _split_url(raw)
        if any(_on(host, d) and (path + "/").lower().startswith(prefix) for d, prefix in ITEM_PAGES):
            if host + path not in seen:
                seen.append(host + path)
    return seen


def parse_sourcing(output):
    """The parsed card, or SourcingFormatError naming the first line that is wrong.

    Returns {qty, item, picks, reserves, any_second_hand, any_new, spend}.
    A reserve written `none found` is None in `reserves`.
    """
    text = output or ""
    fields = {}
    picks = {}
    for key, value, m in key_lines(text):
        if key.startswith("PICK"):
            num = int(m.group("picknum") or 1)
            if num in picks:
                raise SourcingFormatError(f"PICK {num} is written twice; give each pick its own number")
            picks[num] = value
            continue
        if key.startswith("RESERVE"):
            num = m.group("resnum")
            if num not in ("1", "2"):
                raise SourcingFormatError(
                    f"RESERVE {num} is not allowed; a sourcing card has RESERVE 1 and RESERVE 2 only")
            key = f"RESERVE {num}"
        if key in fields:
            raise SourcingFormatError(f"the {key} line is written twice; keep one")
        fields[key] = value

    sourcing = fields.get("SOURCING", "")
    qm = QTY_RE.search(sourcing)
    if not qm:
        raise SourcingFormatError(
            "the SOURCING line must read <item> x <number> for <property>, "
            "for example SOURCING: Fridge freezer x 4 for 13 Chedburgh Place")
    qty = int(qm.group(1))
    if qty < 1:
        raise SourcingFormatError("the quantity on the SOURCING line must be 1 or more")
    item = sourcing[:qm.start()].strip()

    for key in REQUIRED_TEXT:
        if not fields.get(key, "").strip():
            raise SourcingFormatError(
                f"the {key} line is missing or empty; write {key}: and what it says on the card shape")

    if not picks:
        raise SourcingFormatError(
            "there is no PICK line; write PICK: name | new or second-hand | £full price | link")
    if len(picks) > qty:
        raise SourcingFormatError(
            f"the card has {len(picks)} PICK lines for a quantity of {qty}; offer at most one pick per unit "
            "needed and put the rest in RESERVE 1 and RESERVE 2")
    parsed_picks = [_item(picks[n], "PICK" if n == 1 and len(picks) == 1 else f"PICK {n}")
                    for n in sorted(picks)]

    reserves = []
    for n in ("1", "2"):
        key = f"RESERVE {n}"
        if key not in fields:
            raise SourcingFormatError(
                f"the {key} line is missing; write {key}: name | new or second-hand | £full price | link, "
                f"or {key}: none found")
        value = fields[key].strip()
        if not value:
            raise SourcingFormatError(f"the {key} line is empty; give a reserve or write {key}: none found")
        reserves.append(None if value.lower().startswith("none found") else _item(value, key))

    any_second_hand = any(p["kind"] == "second-hand" for p in parsed_picks)
    any_new = any(p["kind"] == "new" for p in parsed_picks)

    comparison = fields.get("NEW FOR COMPARISON")
    if any_second_hand:
        if comparison is None or not comparison.strip():
            raise SourcingFormatError(
                "a second-hand pick needs a NEW FOR COMPARISON line so Kevin sees the new price; write "
                "NEW FOR COMPARISON: item | £full price | link, or NEW FOR COMPARISON: not found: <why>")
    if comparison is not None and comparison.strip():
        c = comparison.strip()
        if c.lower().startswith("not found"):
            if not c[len("not found"):].strip(" :").strip():
                raise SourcingFormatError(
                    "NEW FOR COMPARISON: not found must say why, for example not found: no shop sells this model")
        else:
            parts = [p.strip() for p in c.split("|")]
            if len(parts) != 3 or not parts[0]:
                raise SourcingFormatError(
                    "NEW FOR COMPARISON must have three parts split by ' | ': item | £full price | link, "
                    "or say not found: <why>")
            _price(parts[1], "NEW FOR COMPARISON")
            _link(parts[2], "NEW FOR COMPARISON")

    cashback = fields.get("CASHBACK")
    if cashback is None or not cashback.strip():
        raise SourcingFormatError(
            "the CASHBACK line is missing or empty; write the TopCashback rate, none offered, "
            "not checked: <why>, or n/a when every pick is second-hand")
    cb = cashback.strip().lower().rstrip(".")
    if any_new and cb == "n/a":
        raise SourcingFormatError(
            "CASHBACK cannot be n/a when a pick is new; check TopCashback and write the rate, "
            "none offered, or not checked: <why>")
    if cb.startswith("not checked") and not cb[len("not checked"):].strip(" :").strip():
        raise SourcingFormatError("CASHBACK: not checked must say why, for example not checked: site refused the robot")

    spend = spend_amount(text)
    if spend is None:
        raise SourcingFormatError(
            "there is no SPEND line with an amount; write SPEND: £<total> (one-off)")

    links = card_links(text)
    if len(links) > qty + 3:
        raise SourcingFormatError(
            f"the card carries {len(links)} links and a quantity of {qty} allows {qty + 3}; a sourcing card "
            "carries the pick(s), two reserves and at most one comparison link; name the sites you searched "
            "in words, and keep ruled-out items as words without links")

    return {"qty": qty, "item": item, "picks": parsed_picks, "reserves": reserves,
            "any_second_hand": any_second_hand, "any_new": any_new, "spend": spend}


def sourcing_problem(output):
    """'' when the output is not a sourcing card or is a good one, else one plain sentence."""
    if not is_sourcing(output):
        return ""
    try:
        parse_sourcing(output)
    except SourcingFormatError as exc:
        return f"its SOURCING card is not in Kevin's shape: {exc}"
    return ""


def listing_without_shape_problem(output):
    """'' unless the output offers a marketplace item to buy (an item link and a SPEND
    line) without the SOURCING shape. A room advert on Gumtree or Facebook in another
    card carries no SPEND line, and an order page, a post-an-advert page or a search
    is not an item, so none of them is caught."""
    if is_sourcing(output):
        return ""
    if not item_links(output):
        return ""
    if spend_amount(output) is None:
        return ""
    return ("it offers a marketplace listing to buy and spends money, so it must use the SOURCING card shape: "
            "one pick per unit needed, two reserves and the facts on fixed lines")
