#!/usr/bin/env python3
"""The SOURCING card contract, shared by the submit gate and the complete gate.

Kevin approved this shape on 11 Nov 2026. On 2 Nov 2026 a sourcing card for
four fridge freezers (task reck5ZY5MoXulxJz8) reached him with ten listing
links and a wall of text, and he had to vet every link himself.

THREE RULES, HELD BY CONSTRUCTION (second review, 11 Nov 2026)
(i)   A card is a sourcing card if and only if a line starts with exactly
      `SOURCING:`, upper case, nothing before it.
(ii)  Every fact key is the plain upper-case key at the start of a line. No
      bullets, no bold, no quote marks, no case folding, so prose such as
      "Saving: ...", "- Searched: ..." or "> Sourcing: ..." is never a key.
      The one leniency: a dressed-up SOURCING key (`**SOURCING:**`,
      `- SOURCING:`) is refused with "write the keys plain", never let past.
(iii) Kevin is never handed a wall of second-hand listings: more than
      quantity + 3 distinct marketplace item links is refused.

ONE MORE, FROM THE ALARM TEST (Kevin, 12 Nov 2026)
(iv)  SPEND is the sum of the PICK lines, to the penny. Every PICK line
      carries the full amount for that line (count times unit price, delivery
      and VAT in). A set of six smoke alarms and one heat alarm passed this
      check with unit prices on its PICK lines and a total nothing had added
      up, so a card with a wrong total would have reached Kevin as checked.
      Two things keep that sum honest (review, 12 Nov 2026). Any line
      WRITTEN like an item (`... | new | ...` or `... | second-hand | ...`)
      must start with one of the card's plain keys, whatever it is called
      (`PICK2:`, `Pick 2:`, `- PICK 2:`, `1. PICK 2 (promoted):`), because a
      line the key pattern does not read is left out of the sum. A line
      under a plain key is accounted for: PICK is summed, RESERVE is parsed,
      and BASELINE may carry a preferred-list row, which prints the same
      bars. The rule is on the shape of the line, not on a list of
      misspellings. And the SPEND
      line the dispatcher reads (its pattern takes the first match, in any
      case, after spaces) must be this card's SPEND line.

AGENT OUTPUT FORMAT: the SHAPE text below. Other card text (CHECKED:, the
bold Approve line, TRACK RECORD, KEVIN ONLY, the closing line) may sit around
the keys, in any order.

Pure functions, no network. SPEND_LINE_RE is a copy of the one in
agent-dispatch.py (a hyphenated file cannot be imported here);
tests/sourcing-card.test.js checks the two behave the same.
"""

import re
from urllib.parse import urlsplit


class SourcingFormatError(ValueError):
    pass


# Must behave exactly like SPEND_LINE_RE in scripts/agent-dispatch.py.
SPEND_LINE_RE = re.compile(
    r"^\s*SPEND:\s*£?\s*(?P<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*"
    r"(?P<recurring>(?:/|per\s+|a\s+|each\s+|every\s+)?"
    r"(?:month|week|year|quarter|annum|recurring|monthly|weekly|annually|yearly)\b)?",
    re.I | re.M)

# Stamped at the start of a Notes line by agent-dispatch.py submit when it accepts a sourcing card,
# so the close gate still fires after a later output on the same task drops the SOURCING line. Only
# a real stamp counts: a track-record copy of it in another task's Notes is bulleted ("- ...").
SOURCING_SUBMITTED_MARK = "SOURCING CARD SUBMITTED"
SOURCING_SUBMITTED_RE = re.compile(r"^\[[^\]\n]*\] " + SOURCING_SUBMITTED_MARK, re.M)

# Strict keys: case-sensitive, at the very start of a line. NOT PROVEN is tried before PROVEN.
KEY_RE = re.compile(
    r"^(?P<key>SOURCING|BASELINE|PICK(?: \d+)?|RESERVE \d+|NEW FOR COMPARISON|CASHBACK"
    r"|NOT PROVEN|PROVEN|SAVING|PAY BY|SEARCHED|SPEND):[ \t]*(?P<value>.*?)[ \t]*$", re.M)
# The one leniency: a SOURCING key dressed in bullets or bold, so such a card is refused, not skipped.
DRESSED_SOURCING_RE = re.compile(r"^ *[-*•_ ]+SOURCING[*_ ]*:|^SOURCING[*_ ]+:", re.M)

# A line written like an item: the kind sits between two pipes. Such a line must start with one of
# the card's plain keys (KEY_RE), or its price is in no total and nothing has checked it.
ITEM_SHAPED_RE = re.compile(r"\|[ \t*_]*(?:new|second-hand)[ \t*_]*\|", re.I)

PRICE_RE = re.compile(r"^£([0-9][0-9,]*(?:\.[0-9]{1,2})?)$")
LINK_RE = re.compile(r"^https?://\S+$")
URL_RE = re.compile(r"https?://[^\s<>()\[\]\"'`]+", re.I)
KINDS = ("new", "second-hand")
REQUIRED_TEXT = ("BASELINE", "PROVEN", "NOT PROVEN", "SAVING", "PAY BY", "SEARCHED")

# A marketplace ITEM page, (host, path prefix); '' means any path on that host. The same matcher
# serves the cap and the backstop. An order page, a post-an-advert page or a search is not an item.
ITEM_PAGES = (("facebook.com", "/marketplace/item/"), ("facebook.com", "/share/"), ("fb.me", ""),
              ("gumtree.com", "/p/"), ("ebay.co.uk", "/itm/"), ("ebay.us", ""),
              ("vinted.co.uk", "/items/"))

SHAPE = (
    "SOURCING: <item> | <quantity> | <property>\n"
    "BASELINE: <last buy on the preferred list: item, supplier, £price, date> | none on the list\n"
    "PICK: <name, with the count when the line covers more than one> | <new|second-hand> | "
    "£<full amount for this line, delivery and VAT in> | <https link>\n"
    "RESERVE 1: <name> | <new|second-hand> | £<full price> | <https link>   (or: RESERVE 1: none found)\n"
    "RESERVE 2: <same>   (or: RESERVE 2: none found)\n"
    "NEW FOR COMPARISON: <item> | £<full price> | <https link>   (or: NEW FOR COMPARISON: not found: <why>)\n"
    "CASHBACK: <TopCashback rate or £, expected not guaranteed> | none offered | not checked: <why> | n/a\n"
    "PROVEN: <what the listing or page proves against the buying rules>\n"
    "NOT PROVEN: <what it does not prove> | nothing\n"
    "SAVING: <£ against the baseline, or against the new price> | no baseline\n"
    "PAY BY: <shop checkout | seller: bank transfer | seller: cash on collection>\n"
    "SEARCHED: <sites searched, in words, and any site NOT CHECKED with why>\n"
    "SPEND: £<the PICK lines added up> (one-off)\n"
    "Every key plain and in capitals at the start of its line. More than one unit: PICK 1:, PICK 2: ... "
    "up to the quantity. SPEND must equal the PICK lines added together, to the penny."
)


def is_sourcing(output):
    """True when a line starts with exactly `SOURCING:` (rule i)."""
    return bool(re.search(r"^SOURCING:", output or "", re.M))


def _price(value, where):
    m = PRICE_RE.match(value)
    if not m:
        raise SourcingFormatError(f"the price on {where} reads {value!r}; write the price plain, for example £70.00")
    amount = float(m.group(1).replace(",", ""))
    if amount <= 0:
        raise SourcingFormatError(f"the price on {where} must be more than £0, got {value!r}")
    return amount


def _link(value, where):
    if not LINK_RE.match(value):
        raise SourcingFormatError(f"the link on {where} must be one http or https address, got {value!r}")
    return value


def _fields(value, n, where, form):
    parts = [p.strip() for p in value.split("|")]
    if len(parts) != n or not parts[0]:
        raise SourcingFormatError(f"{where} must read {form}, with {n} parts split by ' | '; it has {len(parts)}")
    return parts


def _item(value, where):
    """One PICK or RESERVE line in its four-field form."""
    name, kind, price, link = _fields(value, 4, where, "name | new or second-hand | £full price | link")
    if kind.lower() not in KINDS:
        raise SourcingFormatError(f"the second part of {where} must be new or second-hand, got {kind!r}")
    return {"name": name, "kind": kind.lower(), "price": _price(price, where), "link": _link(link, where)}


def item_links(output):
    """The distinct marketplace item links (rule iii and the backstop). www., m. and mobile. are the
    same host, any other subdomain counts as the site, and the query string, fragment, trailing slash
    and trailing punctuation are ignored, so one listing written several ways counts once."""
    seen = []
    for raw in URL_RE.findall(output or ""):
        try:
            parts = urlsplit(raw.rstrip(".,;:!?*_"))
        except ValueError:
            continue
        host = re.sub(r"^(?:www|m|mobile)\.", "", (parts.hostname or "").lower())
        path = parts.path.rstrip("/")
        if any((host == d or host.endswith("." + d)) and (path + "/").lower().startswith(prefix or "/")
               for d, prefix in ITEM_PAGES) and host + path not in seen:
            seen.append(host + path)
    return seen


def parse_sourcing(output):
    """The parsed card, or SourcingFormatError naming the first line that is wrong.

    Returns {qty, item, property, picks, reserves, any_second_hand, any_new, spend}.
    `spend` always equals the sum of the pick prices (rule iv).
    A reserve written `none found` is None in `reserves`.
    """
    text = output or ""
    fields, picks = {}, []
    for m in KEY_RE.finditer(text):
        key, value = m.group("key"), m.group("value")
        if key.startswith("PICK"):
            picks.append((key, value))
        elif key in fields:
            raise SourcingFormatError(f"the {key} line is written twice; keep one")
        else:
            fields[key] = value

    item, qty_text, prop = _fields(fields.get("SOURCING", ""), 3, "the SOURCING line",
                                   "SOURCING: <item> | <quantity> | <property>, for example "
                                   "SOURCING: Fridge freezer | 4 | 13 Chedburgh Place")
    if not re.fullmatch(r"[0-9]+", qty_text) or int(qty_text) < 1 or not prop:
        raise SourcingFormatError(
            "the SOURCING line must read SOURCING: <item> | <quantity> | <property>, with a whole number of 1 or "
            "more and the property named, for example SOURCING: Fridge freezer | 4 | 13 Chedburgh Place")
    qty = int(qty_text)

    for key in REQUIRED_TEXT:
        if not fields.get(key):
            raise SourcingFormatError(f"the {key} line is missing or empty; write {key}: and what it says on the card shape")

    for line in text.splitlines():
        if ITEM_SHAPED_RE.search(line) and not KEY_RE.match(line):
            raise SourcingFormatError(
                f"a line is written like an item but does not start with the plain key, so its price is in no "
                f"total: {line.strip()[:60]!r}; start it PICK: or PICK 1: (or RESERVE 1:) in capitals at the very "
                "start of the line, or write it as a sentence without the | bars")
    if not picks:
        raise SourcingFormatError("there is no PICK line; write PICK: name | new or second-hand | £full price | link")
    if len(picks) > qty:
        raise SourcingFormatError(
            f"the card has {len(picks)} PICK lines for a quantity of {qty}; offer at most one pick per unit "
            "needed and put the rest in RESERVE 1 and RESERVE 2")
    parsed_picks = [_item(value, key) for key, value in picks]

    reserves = []
    for key in ("RESERVE 1", "RESERVE 2"):
        value = fields.get(key)
        if not value:
            raise SourcingFormatError(
                f"the {key} line is missing or empty; write {key}: name | new or second-hand | £full price | link, "
                f"or {key}: none found")
        reserves.append(None if value.lower().startswith("none found") else _item(value, key))
    extra = sorted(k for k in fields if k.startswith("RESERVE ") and k not in ("RESERVE 1", "RESERVE 2"))
    if extra:
        raise SourcingFormatError(f"{extra[0]} is not allowed; a sourcing card has RESERVE 1 and RESERVE 2 only")

    any_second_hand = any(p["kind"] == "second-hand" for p in parsed_picks)
    any_new = any(p["kind"] == "new" for p in parsed_picks)

    comparison = fields.get("NEW FOR COMPARISON", "")
    if any_second_hand and not comparison:
        raise SourcingFormatError(
            "a second-hand pick needs a NEW FOR COMPARISON line so Kevin sees the new price; write "
            "NEW FOR COMPARISON: item | £full price | link, or NEW FOR COMPARISON: not found: <why>")
    if comparison.lower().startswith("not found"):
        if not comparison[len("not found"):].strip(" :"):
            raise SourcingFormatError(
                "NEW FOR COMPARISON: not found must say why, for example not found: no shop sells this model")
    elif comparison:
        _c, price, link = _fields(comparison, 3, "NEW FOR COMPARISON", "item | £full price | link, or not found: <why>")
        _price(price, "NEW FOR COMPARISON")
        _link(link, "NEW FOR COMPARISON")

    cb = fields.get("CASHBACK", "").lower().rstrip(".")
    if not cb:
        raise SourcingFormatError(
            "the CASHBACK line is missing or empty; write the TopCashback rate, none offered, "
            "not checked: <why>, or n/a when every pick is second-hand")
    if any_new and cb == "n/a":
        raise SourcingFormatError(
            "CASHBACK cannot be n/a when a pick is new; check TopCashback and write the rate, "
            "none offered, or not checked: <why>")
    if cb.startswith("not checked") and not cb[len("not checked"):].strip(" :"):
        raise SourcingFormatError("CASHBACK: not checked must say why, for example not checked: site refused the robot")

    # The plain SPEND key, read by the same pattern dispatch uses, so the two can never disagree.
    sm = SPEND_LINE_RE.match("SPEND: " + fields["SPEND"]) if "SPEND" in fields else None
    if not sm:
        raise SourcingFormatError("there is no plain SPEND line with an amount; write SPEND: £<total> (one-off)")
    spend = float(sm.group("amount").replace(",", ""))
    # The dispatcher takes the FIRST line its pattern matches. That must be this SPEND line, or the
    # money rule would run on a figure this check never saw.
    first = SPEND_LINE_RE.search(text)
    if (first.group("amount"), bool(first.group("recurring"))) != (sm.group("amount"), bool(sm.group("recurring"))):
        raise SourcingFormatError(
            f"a line above the SPEND line also reads as a spend (£{first.group('amount')}), and the money rule "
            "would take that figure; keep one SPEND line and start no other line with the word spend")
    # Rule iv, in whole pence so 0.1 + 0.2 never reads as a mismatch.
    picks_pence = sum(round(p["price"] * 100) for p in parsed_picks)
    if round(spend * 100) != picks_pence:
        raise SourcingFormatError(
            f"SPEND reads £{spend:,.2f} but the PICK lines add up to £{picks_pence / 100:,.2f}; every PICK line "
            "carries the full amount for that line (count times unit price, delivery and VAT in) and SPEND is "
            "their sum")

    links = item_links(text)
    if len(links) > qty + 3:
        raise SourcingFormatError(
            f"the card carries {len(links)} marketplace listing links and a quantity of {qty} allows {qty + 3}; "
            "offer the pick(s) and two reserves, and keep ruled-out listings as words without links")

    return {"qty": qty, "item": item, "property": prop, "picks": parsed_picks, "reserves": reserves,
            "any_second_hand": any_second_hand, "any_new": any_new,
            "spend": spend}


def sourcing_problem(output):
    """'' when the output is not a sourcing card or is a good one, else one plain sentence."""
    if not is_sourcing(output):
        if DRESSED_SOURCING_RE.search(output or ""):
            return "write the SOURCING card's keys plain, at the start of the line, with no bullets and no bold"
        return ""
    try:
        parse_sourcing(output)
    except SourcingFormatError as exc:
        return f"its SOURCING card is not in Kevin's shape: {exc}"
    return ""


def listing_without_shape_problem(output):
    """'' unless the output offers a marketplace item to buy (an item link and a SPEND line dispatch
    reads) without the SOURCING shape. A room advert carries no SPEND line, and an order page, a
    post-an-advert page or a search is not an item, so none of them is caught."""
    if is_sourcing(output) or not item_links(output) or not SPEND_LINE_RE.search(output or ""):
        return ""
    return ("it offers a marketplace listing to buy and spends money, so it must use the SOURCING card shape: "
            "one pick per unit needed, two reserves and the facts on fixed lines")
