# Wikidata Source Saver 2.0

Install: chrome://extensions -> Developer mode -> Load unpacked (or Reload). Be logged in to wikidata.org.

## Use
1. Copy a Wikidata item: `Q42` or its URL (the clipboard must START with the item; pasted JSON/other text is rejected).
   Optional extra terms after it, separated by commas, semicolons or new lines; several words per term are fine, and a
   language tag applies to the terms after it:  `Q123, en: Pythagorean theorem, it: teorema di Pitagora`
   (terms before any tag go to every website).
2. Open a page on a configured website, press Alt+Shift+S (or click the icon).
   Alt+Shift+A = this page only. Alt+Shift+X = stop. A run in progress ignores repeated shortcuts;
   the toolbar badge shows progress (blue %), clicking the icon during a run stops it.

## What it does
* Terms come ONLY from the page's own ID and the extras you type. Wikidata labels and aliases are never used. Nothing is
  guessed; terms with symbols/formulas/>6 words are dropped. For a run-together ID (PythagoreanTheorem) the words are read
  from the capitals, or from a matching extra. Each website has a language list and only receives terms in its language(s)
  (no language on either side = no restriction).
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
Templates: `{id}`, `{first}`/`{FIRST}`, `{a|b|c}` choices. Separator(s) + letter case convert the term between sites.
Tick several separators for inconsistent sites (investopedia: `none` + `hyphen` tries incomestatement and income-statement).
Categories: several allowed (`math, geometry`); sites sharing any category are related.
ID property: save `P2812: MonotonicFunction` instead of P1343/P2699. If the property stores more than the {id} part, add a value
pattern after the property: `P10715:{first}/{id} https://www.investopedia.com/terms/{first}/{id}.asp` stores `f/financial-statements`
(placeholders {id}, {first}, {FIRST}; also available per website as "ID value pattern" in Advanced). It is used both when reading a page
and when building IDs for other websites, so the history and duplicate checks compare the full value. Per template: start a template line with the
property (`P9999 https://www.econlib.org/library/Enc/{id}.html`); lines without one use the site's default ID property,
or fall back to P1343 + P2699 (needs the website item); `P1343 https://…` forces the fallback.
Search: URL with `{q}` (+) or `{q20}` (%20); "link text matches the term" (mathsisfun; ignores case, accents, punctuation, and CamelCase/no-space spellings) or
"URL contains the term, keep the most general path" (Khan Academy, ScienceDirect topics); "render in a background tab"
for JavaScript-driven result pages.
"Link text must contain the term" + "matches that don't also equal the term must be approved": exact matches are listed first,
partial matches always open the review window and start unticked, whatever the review setting.
Archive: always add the latest Wayback snapshot; viewing web.archive.org/web/<ts>/<url> uses that snapshot.

## Debug log
Every run is logged step by step (page/ID read, terms, every URL requested with status and time, search results, plan,
review, the exact edit, errors). Last 8 runs are kept: Settings -> Debug log -> download/show. Tick "save a log file after every run"
to also get Downloads/WikidataSourceSaver/run-<time>-<item>.log automatically (optional 'downloads' permission).
The username and tokens are never written to the log.

## Search scripts (sites whose results need clicking, e.g. Khan Academy)
Settings -> website -> "Use the website's own search engine" -> Search script. Runs in a background tab:

    click button "See our Google-powered results"
    each "Videos", "Articles", "Programs"
      click text "{x}"
      collect
      pages link "Page {n}"

Steps: click button|link|tab|text "name" [exact] / collect / pages link "Page {n}" [max=10] (clicks Page 2, 3 ... until there
is no such link; exact name preferred, so "Page 2" never hits "Page 20") / wait ms / each "A","B" + indented block / # comment.
Pasted Playwright locators (get_by_role("button", name="..."), get_by_text("...")) work as click steps.
A missing element is noted and skipped (inside `each` the rest of that round is skipped). Each action is a separate step,
so clicks that load a new page work. Hard limits per search (Settings): clicks (60) and seconds (180); pagination also stops
after two pages without new links. Not supported: elements inside iframes or shadow DOM.

## Failure symbols (toolbar badge + start of the notification title; legend in Settings)
✓ saved · +N! saved but some websites had problems · = already there · 0 nothing found · ■ stopped · ✗ review cancelled ·
LOG not logged in · Q? no item in clipboard · CFG website not configured · URL page can't be used · PRM permission needed ·
LAG Wikidata busy (maxlag / 429) · CAP edit limit reached · NET network problem · BLK websites blocked us · API Wikidata refused · ! unexpected.

## maxlag
Reads never send it. Edits send `maxlag` = the Settings value (default 5 s); 0 = off, 12 = patient. While Wikidata lags the
edit is retried 3 times (waits capped at 30 s). If that still fails, the collected changes are NOT dropped: a small window
asks whether to save now ignoring maxlag (this one save only – the setting stays), wait and retry with the same maxlag, or
cancel (LAG, nothing written). Plain rate limits (429/503) are not offered this shortcut.

## Websites list
Filter by category and sort by saved order / name / category / language above the dropdown (remembered).
