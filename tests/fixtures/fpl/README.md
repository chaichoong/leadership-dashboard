# FPL Draft swap fixtures

Recorded reads for `scripts/fpl-draft-swaps.py` and `tests/fpl-draft-swaps.test.js`.
Public endpoints only, no key, no personal data: squad shapes and public player stats.
Every file is trimmed to the fields the script reads.

| Directory | What it is |
| --- | --- |
| `live-20261127/` | The real reads, taken 27 Nov 2026 07:36 London: `draft.premierleague.com/api/game`, `/api/bootstrap-static`, `/api/entry/96186/event/11`, `/api/league/18988/element-status`, and `fantasy.premierleague.com/api/fixtures/?event=12..16`. A recording, unedited apart from the field trim and one scrub: this repo is PUBLIC, so the other two league members' entry ids in `element-status.json` are replaced with 900001 and 900002. Kevin's own entry (96186) stays, because it is his squad and his own approved plan names it. Kept as the shape control: if the sites change their reply, a read of this directory still works and the live one stops, which tells you which side moved. |
| `gw11-expected/` | Kevin's 20 Nov 2026 gameweek, **reconstructed**. The three players he signed (N.Jackson, Verbruggen, McGinn) are put back in the free-agent pool and the three he dropped (McBurnie, Pickford, Dewsbury-Hall) back in his 15, with Hall left in the pool as the swap he considered and did not make. Fixtures and difficulties are the real GW11 to GW15 reads. Player figures are the live 27 Nov ones, because the draft site keeps no pre-gameweek snapshot of points per game, so this is that morning's **situation**, not that morning's numbers. |
| `edge/` | Hand-built, 19 invented players. One A-grade on a bad week, a free agent on 299 minutes beside an identical one on 300, a doubtful player at 50%, and a club with no fixture that gameweek. Nothing here is a real player. |
| `fail-game-500/` | `game.json` holds a 500 error page instead of JSON. |
| `fail-no-waivers-key/` | `game.json` is valid JSON with `waivers_processed` missing. |
| `fail-no-pick-history/` | `picks-11.json` holds the string `"No pick history"`, which is what the draft site returns for a gameweek not yet played. The dangerous one: read as an empty squad it would mean "you own nobody", and every free agent would beat nobody. |

## What `gw11-expected` proves, and what it found

Two of Kevin's three swaps come straight out of his five rules: McBurnie out for
N.Jackson, Pickford out for Verbruggen with Verbruggen starting in goal.

The third does not. McGinn beats Dewsbury-Hall this week (4.44 against 4.25) and is worse
over the next five gameweeks (21.46 against 23.75), so rule 2 refuses the swap Kevin made
by hand. On that morning's figures he may well have been right; on these figures the rule
says no, and the card has to say no too. The test asserts the refusal rather than bending
the rule to the recorded outcome.

## Rebuilding them

The builder is not kept in the repo: these are recordings, and a script that re-records
them against the live sites would quietly replace a control with whatever today returns.
To take a fresh recording, read the endpoints listed above, trim each element to
`id, web_name, element_type, team, minutes, points_per_game, chance_of_playing_next_round,
status, form, news, news_return`, trim each fixture to `id, event, team_h, team_a,
team_h_difficulty, team_a_difficulty`, and write it to a NEW dated directory beside
`live-20261127/` rather than over it.
