# Wikidata Source Saver 2.0

Install: chrome://extensions -> Developer mode -> Load unpacked (or Reload). Be logged in to wikidata.org.

## Use
1. Copy a Wikidata item: `Q42` or its URL (the clipboard must START with the item; pasted JSON/other text is rejected).
   Optional extra terms after it: `Q123, use of property`.
2. Open a page on a configured website, press Alt+Shift+S (or click the icon).
   Alt+Shift+A = this page only. Alt+Shift+X = stop. A run in progress ignores repeated shortcuts;
   the toolbar badge shows progress (blue %), clicking the icon during a run stops it.

## What it does
* Terms come ONLY from: the item's Wikidata label/aliases, your extra terms, and the page's own ID. Nothing is guessed;
  terms with symbols/formulas/>6 words are dropped.
* Template URLs of sites in the same category(ies) are checked; sites with their own search engine are searched
  with the item's label; pages that exist (or have a Wayback snapshot, for "unreliable" sites) are proposed.
* Everything goes into ONE edit: P1343 + P2699 (+ P1065/P2960 for archive sites), or the site's own ID property.
* All plain URLs of one website share ONE P1343 statement (several P2699 qualifiers), added to the item's existing
  P1343 statement for that website if there is one. URLs with their own archive link keep their own statement so each
  P2699 stays paired with its P1065 (an archive link is only added to an existing statement that holds a single URL).
* Review window: opens when there are more than N new statements or anything came from a site search.

## Wikimedia policy safeguards
Each run is started by you; one edit per run; max statements per edit; >= 60 s between edits (waits, with countdown);
max edits/hour; `maxlag=5` and Retry-After honoured; `assert=user`; Api-User-Agent with your username (Settings);
requests to any website are one-at-a-time per host with a delay, and a host that answers 403/429/503 (or 5xx twice) is
left alone for the rest of the run. Misses are cached (default 14 days). Don't lower the limits for bulk work -
request a bot account for that.

## History log
Everything pushed, or found already present, is logged (Settings -> History log; export/import as JSON) and is not
re-checked next time. "Forget this item" if a statement was removed on Wikidata.

## Websites (Settings, one at a time via the dropdown)
Templates: `{id}`, `{first}`/`{FIRST}`, `{a|b|c}` choices. Separator + letter case convert the term between sites.
Categories: several allowed (`math, geometry`); sites sharing any category are related.
ID property: save `P2812: MonotonicFunction` instead of P1343/P2699. Per template: start a template line with the
property (`P9999 https://www.econlib.org/library/Enc/{id}.html`); lines without one use the site's default ID property,
or fall back to P1343 + P2699 (needs the website item); `P1343 https://…` forces the fallback.
Search: URL with `{q}` (+) or `{q20}` (%20); "link text matches the term" (mathsisfun; ignores case, accents, punctuation, and CamelCase/no-space spellings) or
"URL contains the term, keep the most general path" (Khan Academy, ScienceDirect topics); "render in a background tab"
for JavaScript-driven result pages.
"Link text must contain the term" + "matches that don't also equal the term must be approved": exact matches are listed first,
partial matches always open the review window and start unticked, whatever the review setting.
Archive: always add the latest Wayback snapshot; viewing web.archive.org/web/<ts>/<url> uses that snapshot.
