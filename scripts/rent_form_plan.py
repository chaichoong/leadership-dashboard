#!/usr/bin/env python3
"""The direct rent payment form for a new tenant (Cash Flow Voids lane B, 3 Oct 2026).

Kevin's ruling, 3 Oct 2026: "Robot fills, you pick reason." Once Roy says a new Universal Credit
tenant's housing costs are verified, a card comes to Kevin. Approving it gives him the Your turn
button: the robot opens the DWP's "Apply for direct rent payments" form in its own window and
fills every answer the records hold. Kevin chooses the reason this tenant needs the rent paid
direct (a new tenant has no arrears, so the DWP asks for a reason, and the reason is HIS statement,
never the robot's), types the code the DWP emails to info@agilelets.co.uk and the bank sort code
and account number, checks every answer and sends. The robot never presses send.

This file is pure: records in, the answers (each with the record it came from) and the robot's
handover plan out (scripts/agent-browser.js `handover`). It reads and writes nothing.

THE FORM, AS FAR AS IT HAS BEEN SEEN (ids read from the live form on 11 Aug and 2 Oct 2026)
  /                                    "Start now"
  /questions/type-of-payment           #f-typeOfPayment = "Direct rent payment" (a named answer for the
                                       robot's final-action guard, agent-browser.js BUILTIN_SITES)
  /questions/two-months-arrears        #f-twoMonthsArrears-2 = "No"
  (not seen yet)                       the reason, Kevin's: the robot waits for the rent page
Those first two answers are the robot's only while the records show the tenant has missed less than
two months' rent, and only until the day before the next rent falls due (the plan's `validUntil`:
agent-browser.js refuses the plan after it, and the rent check raises a fresh card). Otherwise, when
the records cannot say, or when that day is under MIN_GOOD_DAYS away, both are Kevin's too: the robot
opens the form and waits for the rent page (the arrears route has not been seen, so it is never
guessed). Each answer is picked by its id and its own words, so a reordered form stops the robot.
  /questions/rent-details              #f-rentAmount, "How often is the rent paid?"
  /questions/tenant-details            #f-tenantFullName, date of birth, address
  /questions/landlord-details          #f-landlordFullName, #f-landlordPhoneNumber, #f-landlordEmailAddress, address
  /questions/confirm-your-email        the emailed code, Kevin's: the robot waits for the bank page
  /questions/landlord-bank-details     #f-accountHolder, #f-paymentReference; sort code and account number, Kevin's
  /questions/review                    "Accept and send", Kevin's
A page that differs from this stops the robot at that step and the window is Kevin's to finish
by hand (agent-browser.js runHandover): it never guesses past a page it does not know.
"""

import hashlib
import json
import os
import re
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Kevin's ruling, 11 Aug 2026: the landlord email on the form is always info@agilelets.co.uk. The
# one definition of that address is the estate's (agent_email_format.py).
from agent_email_format import PROPERTY_SENDER as LANDLORD_EMAIL  # noqa: E402

FORM_URL = "https://directpayment.universal-credit.service.gov.uk/"
FORM_SITE = "directpayment.universal-credit.service.gov.uk"
# The rent check only knows monthly rent (scripts/rent-check.py works in due days of the month), so
# a tenancy paid any other way is not filled here: its arrears could not be counted. A blank frequency
# is monthly, as the app reads it (js/income.js getIncomeFrequency, js/cashflow.js).
FREQUENCY = "Monthly"
# The robot answers "has not missed two months" only while that answer holds this many days or more:
# a card raised the day before a rent falls due would be out of date before Kevin could use it.
MIN_GOOD_DAYS = 3
LANDLORD_KEYS = ("full_name", "phone_number", "email_address", "account_holder")
CONTINUE = "#continue-button"
WHY = ("choose the reason this tenant needs the rent paid direct if the form has not asked yet, type the sort code "
       "and account number, check every answer, and press Accept and send")


def _label(text):
    """A field found by its label's words: the robot fills the box the label belongs to."""
    return f'label:has-text("{text}")'


def _id(field_id):
    """A field by its id, written so brackets in the id need no escaping."""
    return f'[id="{field_id}"]'


def address_lines(address, postcode, area):
    """(building and street, town) for the tenant's address, as the proof of residency gives it:
    the property's address with no unit prefix. The postcode is its own box."""
    parts = [p.strip() for p in str(address or "").split(",") if p.strip()]
    code = re.sub(r"\s+", "", str(postcode or "")).upper()
    parts = [p for p in parts if re.sub(r"\s+", "", p).upper() != code]
    building = parts[0] if parts else ""
    town = str(area or "").strip() or (parts[1] if len(parts) > 1 else "")
    return building, town


# The answers that change with the calendar alone (a rent falling due moves the count): left out of the
# print, so a card Kevin sent back is not raised early with nothing he asked for fixed.
COUNTED = ("Type of payment", "Has the tenant missed 2 months or more of rent?")


def fingerprint(answers):
    """A short print of the answers read from the records, kept on the card, so a card Kevin sent back
    for changes is only raised again once one of them has changed (scripts/rent_new_tenant.py)."""
    kept = [a for a in answers if a[0] not in COUNTED]
    return hashlib.sha1(json.dumps(kept, sort_keys=True).encode()).hexdigest()[:12]


def owes_two(arrears):
    """True when the records show two months' rent or more unpaid; None when they cannot say."""
    if not arrears:
        return None
    return arrears["months"] >= 2 - 0.01


def good_until(arrears):
    """The last day the robot's "No" to the arrears question holds: the day before the next rent
    falls due, when the count can change. None when the robot is not to answer it: two months or more
    unpaid, a count the records cannot make, or an answer that would hold under MIN_GOOD_DAYS."""
    if owes_two(arrears) is not False or not arrears.get("next") or not arrears.get("asAt"):
        return None
    last = date.fromisoformat(arrears["next"]) - timedelta(days=1)
    return last if (last - date.fromisoformat(arrears["asAt"])).days >= MIN_GOOD_DAYS else None


def build(tenancy, tenant, prop, landlord, roy=None, place="", arrears=None):
    """{"answers": [(question, answer, source)], "plan": {...}, "missing": [what is blank and where]}.
    A plan is only returned when nothing is missing: a blank box would stop the robot part way.
    `arrears` is what the rent check counted ({"months", "owed", "falls", "paid"}, scripts/
    rent_new_tenant.py months_unpaid), or None when it could not count."""
    missing = []

    def need(value, what, where):
        if value in (None, "", 0):
            missing.append(f"{what} ({where})")
        return value

    rent = need(tenancy.get("rent"), "the rent", f"tenancy record {tenancy.get('id')}")
    frequency = FREQUENCY if str(tenancy.get("frequency") or FREQUENCY) == FREQUENCY else None
    if not frequency:
        missing.append(f"a monthly rent (tenancy record {tenancy.get('id')} says "
                       f"'{tenancy.get('frequency') or 'blank'}', and the rent check only counts monthly rent)")
    name = need(str(tenant.get("name") or "").strip(), "the tenant's name", f"tenant record {tenant.get('id')}")
    dob = need(str(tenant.get("dob") or "")[:10], "the tenant's date of birth", f"tenant record {tenant.get('id')}")
    building, town = address_lines(prop.get("address"), prop.get("postcode"), prop.get("area"))
    need(building, "the property's address", f"property record {prop.get('id')}")
    need(town, "the property's town", f"property record {prop.get('id')}")
    postcode = need(str(prop.get("postcode") or "").strip(), "the property's postcode", f"property record {prop.get('id')}")
    for key in LANDLORD_KEYS:
        need(str((landlord or {}).get(key) or "").strip(), f"the landlord's {key.replace('_', ' ')}", "the private landlord file")
    laddr = (landlord or {}).get("address") or {}
    for key in ("line1", "town_city", "postcode"):
        need(str(laddr.get(key) or "").strip(), f"the landlord's address {key.replace('_', ' ')}", "the private landlord file")
    if str((landlord or {}).get("email_address") or "").strip().lower() not in ("", LANDLORD_EMAIL):
        missing.append(f"the landlord email must be {LANDLORD_EMAIL} (Kevin's ruling, 11 Aug 2026), not another address")
    if dob and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", dob):
        missing.append(f"a date of birth that reads as a date (tenant record {tenant.get('id')})")
    surname = name.split()[-1] if name else ""
    until = good_until(arrears)
    months = (f"{arrears['falls']} month's" if arrears['falls'] == 1 else f"{arrears['falls']} months'") if arrears else ""
    counted = (f"£{arrears['owed']:,.2f} unpaid: {months} rent due since the tenancy began, "
               f"£{arrears['paid']:,.2f} matched" if arrears else
               "the rent check could not count the arrears")
    if until:
        first = [("Type of payment", "Direct rent payment", "the rent check: a new cash flow void"),
                 ("Has the tenant missed 2 months or more of rent?",
                  f"No ({counted}). Good until {until.strftime('%-d %b %Y')}: the window refuses it after that and a "
                  "fresh card is raised", "the rent check")]
    else:
        first = [("Type of payment", f"YOURS to choose in the window ({counted})", "the rent check"),
                 ("Has the tenant missed 2 months or more of rent?", f"YOURS to answer in the window ({counted})",
                  "the rent check")]
    answers = first + [
        ("Why the rent should be paid direct", "YOURS to choose in the window if the form asks: your statement to the DWP",
         "Kevin"),
        ("Rent", f"£{float(rent or 0):,.2f}, {frequency or '?'}", f"tenancy record {tenancy.get('id')}"),
        ("Tenant", name or "?", f"tenant record {tenant.get('id')}"),
        ("Date of birth", dob or "?", f"tenant record {tenant.get('id')}"),
        ("Tenant's address", ", ".join(x for x in (building, town, postcode) if x) or "?",
         f"property record {prop.get('id')}, as on the proof of residency (no unit number)"),
        ("Landlord", ", ".join(str(x) for x in ((landlord or {}).get("full_name"), (landlord or {}).get("phone_number"),
                                                 LANDLORD_EMAIL, laddr.get("line1"), laddr.get("town_city"),
                                                 laddr.get("postcode")) if x), "the private landlord file"),
        ("Code emailed to info@", "YOURS to type in the window", "Kevin"),
        ("Bank account holder", str((landlord or {}).get("account_holder") or "?"), "the private landlord file"),
        ("Sort code and account number", "YOURS to type in the window", "Kevin"),
        ("Payment reference", surname or "?", "the tenant's surname"),
    ]
    if missing:
        return {"answers": answers, "plan": None, "missing": missing}
    y, m, d = dob.split("-")
    if until:
        # By id AND by its own words: if the DWP ever reorders the options, the robot stops rather than
        # ticking whatever now sits at that id. The words stop short of "payment", which the robot's guard
        # refuses in any selector; its named-answer check then requires the whole label, exactly.
        opening = [
            {"do": "check", "selector": 'label[for="f-typeOfPayment"]:text-matches("^Direct rent")'},
            {"do": "click", "selector": CONTINUE},
            {"do": "check", "selector": 'label[for="f-twoMonthsArrears-2"]:text-is("No")'},
            {"do": "click", "selector": CONTINUE},
            {"do": "kevin", "say": "Choose the reason this tenant needs the rent paid direct. It is your own statement to "
                                   "the DWP. Then press Continue until the page asking for the rent opens.",
             "untilSelector": "#f-rentAmount", "minutes": 15},
        ]
    else:
        opening = [
            # "your own statement" (7 Oct 2026): a step of Kevin's mid-plan is refused unless it is his
            # sign-in, a code, or his own statement (agent-browser.js assertHandoverPlan), and these
            # three answers are his statements to the DWP, which the records cannot give.
            {"do": "kevin", "say": f"Choose the type of payment, answer whether the tenant has missed 2 months or more "
                                   f"of rent ({counted}), and give the reason if the form asks: all three are your own "
                                   "statement to the DWP. Then press Continue until the page asking for the rent opens.",
             "untilSelector": "#f-rentAmount", "minutes": 15},
        ]
    steps = [
        {"do": "goto", "url": FORM_URL},
        {"do": "click", "selector": 'a:has-text("Start now")'},
    ] + opening + [
        {"do": "fill", "selector": "#f-rentAmount", "value": f"{float(rent):.2f}"},
        {"do": "check", "selector": _label(frequency)},
        {"do": "click", "selector": CONTINUE},
        {"do": "fill", "selector": "#f-tenantFullName", "value": name},
        {"do": "fill", "selector": _label("Day"), "value": str(int(d))},
        {"do": "fill", "selector": _label("Month"), "value": str(int(m))},
        {"do": "fill", "selector": _label("Year"), "value": y},
        {"do": "fill", "selector": _label("Building and street"), "value": building},
        {"do": "fill", "selector": _label("Town or city"), "value": town},
        {"do": "fill", "selector": _label("Postcode"), "value": postcode},
        {"do": "click", "selector": CONTINUE},
        {"do": "fill", "selector": _id("f-landlordFullName"), "value": str(landlord["full_name"])},
        {"do": "fill", "selector": _id("f-landlordPhoneNumber"), "value": str(landlord["phone_number"])},
        {"do": "fill", "selector": _id("f-landlordEmailAddress"), "value": LANDLORD_EMAIL},
        {"do": "fill", "selector": _id("f-landlordAddress[address1]"), "value": str(laddr["line1"])},
    ] + ([{"do": "fill", "selector": _id("f-landlordAddress[address2]"), "value": str(laddr["line2"])}]
         if str(laddr.get("line2") or "").strip() else []) + [
        {"do": "fill", "selector": _label("Town or city"), "value": str(laddr["town_city"])},
        {"do": "fill", "selector": _id("f-landlordAddress[postcode]"), "value": str(laddr["postcode"])},
        {"do": "click", "selector": CONTINUE},
        {"do": "kevin", "say": f"Type the code the DWP has just emailed to {LANDLORD_EMAIL}, then press Continue.",
         "untilSelector": _id("f-accountHolder"), "minutes": 15},
        {"do": "fill", "selector": _id("f-accountHolder"), "value": str(landlord["account_holder"])},
        {"do": "fill", "selector": _id("f-paymentReference"), "value": surname},
    ]
    plan = {"label": f"Direct rent payment form: {place}" if place else "Direct rent payment form",
            "site": FORM_SITE, "why": WHY,
            "sources": "; ".join(f"{q}: {src}" for q, _a, src in answers),
            "steps": steps}
    if until:
        plan["validUntil"] = until.isoformat()            # agent-browser.js handover refuses it after this day
    return {"answers": answers, "plan": plan, "missing": []}


def card_text(answers, tenant_name, place, roy_words, roy_day, prior=None):
    """The card Kevin approves: the ask first, then what approving does, then every answer and
    where it came from, then what is his in the window. The KEVIN ONLY line opens the wall that
    the Your turn button clears (scripts/agent-dispatch.py). `prior` is his last request for
    changes on this tenant's form card ({"on": day, "feedback": words}), quoted so he can see
    whether it was dealt with."""
    said = " ".join(str(roy_words or "").split())[:300]
    lines = [
        f"THE ASK: approve the direct rent payment form for {tenant_name} at {place}."
        + (" Roy says the housing costs are verified." if said else ""),
        "",
    ]
    if said:
        lines += [f"Roy's words ({roy_day}): \"{said}\"", ""]
    if prior:
        lines += [f"Last time ({prior['on']}) you asked for changes: \"{' '.join(str(prior.get('feedback') or '').split())[:300]}\". "
                  "The answers below are read from the records again.", ""]
    lines += [
        "IF YOU APPROVE, THIS HAPPENS",
        "The Your turn button appears on the AI Agents page. One tap opens the robot's own window on the DWP form "
        "with the answers below filled in. The robot never presses send. Nothing is submitted to the DWP until you send "
        "it, though each Continue saves that page on the DWP's side and one of them makes the DWP email the code.",
        "",
        "THE ANSWERS, AND WHERE EACH CAME FROM",
    ]
    lines += [f"- {q}: {a} ({src})" for q, a, src in answers]
    lines += [
        "",
        "YOURS IN THE WINDOW",
        "- The reason this tenant needs the rent paid direct, if the form asks. It is your statement.",
        f"- The code the DWP emails to {LANDLORD_EMAIL}.",
        "- The sort code and account number.",
        "- Checking every answer, then Accept and send. The DWP sends no email when it is sent: the "
        "\"Application complete\" page is the proof.",
        "- When you close the window the app asks whether you finished. Say yes only if you sent it: the rent check then "
        "marks the tenancy CFV Actioned with a comment and asks Roy to check the payment 14 days on.",
        "",
        "IF AN ANSWER IS WRONG",
        "- Approve, and correct it in the window before you send. Or fix the record it came from and press Request "
        "changes: the card is raised again once an answer changes, or a week later. Reject stops the form for this "
        "tenant.",
        "",
        "KEVIN ONLY: credential: type the code the DWP emails to info@agilelets.co.uk and the bank sort code and "
        "account number, choose the reason, check the answers and send the form.",
        "",
        "**Carrying this out will involve:** the robot filling in the DWP direct rent payment form from the records above "
        "in its own window on your Mac. It never presses send.",
    ]
    return "\n".join(lines)
