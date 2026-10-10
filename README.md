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
✓ saved (badge `+N`; with several statements `2+1` = two URLs in one statement + one separate statement, `+N` if there are too many groups for the badge) · +N! / 2+1! saved but some websites had problems · = already there · 0 nothing found · ■ stopped · ✗ review cancelled ·
LOG not logged in · Q? no item in clipboard · CFG website not configured · URL page can't be used · PRM permission needed ·
LAG Wikidata busy (maxlag / 429) · CAP edit limit reached · NET network problem · BLK websites blocked us · API Wikidata refused · ! unexpected.

## maxlag
Reads never send it. Edits send `maxlag` = the Settings value (default 5 s); 0 = off, 12 = patient. While Wikidata lags the
edit is retried 3 times (waits capped at 30 s). If that still fails, the collected changes are NOT dropped: a small window
asks whether to save now ignoring maxlag (this one save only – the setting stays), wait and retry with the same maxlag, or
cancel (LAG, nothing written). Plain rate limits (429/503) are not offered this shortcut.

## Websites list
Filter by category and sort by saved order / name / category / language above the dropdown (remembered).

## Google "site:" search
For websites without a usable search of their own (e.g. encyclopedia.com): Settings -> website -> "Use the website's own search engine"
-> button "Use Google 'site:' search for this website" (needs "Match" or a template so the domain is known). It fills in
`https://www.google.com/search?q=site:encyclopedia.com+{q}`, background-tab mode, "URL contains the term - keep the most general path"
(Google's link texts are noisy), and a script that accepts cookies and reads up to 3 pages. Google's redirect links
(google.com/url?q=...) are unwrapped; only links to the website itself are kept; "Max results kept" and the script limits cap the volume.
A CAPTCHA ("unusual traffic") page stops that search at once and blocks Google for the rest of the run - solve it in a normal tab.

## Check if they exist (Settings -> Test your templates)
Checks up to 20 URLs one at a time. Keep the Settings tab open (a background tab is fine). When it ends you get a summary on the page,
a symbol on the toolbar icon (found/checked, e.g. 7/12; stays until you return to the tab) and a desktop notification. "Stop check" ends it early.

## Review window
The item, every URL, the page of an ID-property row, Wayback dates and the "already on the item" lines are clickable links (new tab).

## IDs spanning several directories: {path}
`{id}` is ONE path segment. Use `{path}` when the ID is several directories, e.g.
`P99999 https://www.encyclopedia.com/{path}` matches `.../history/encyclopedias-almanacs-transcripts-and-maps/industrial-capitalism`
and stores that whole path as the value. The term (for other websites and searches) comes from the last part ("industrial capitalism").
Because the directories can't be guessed, a `{path}` template is only read (from the page you are on, and from search results such as
the Google `site:` search) - it is never used to guess URLs from a term. Pair it with a search script/Google preset to find the pages.

## "Doesn't exist" cache (why a page might be skipped)
Pages that definitely don't exist (HTTP 404/410, redirected elsewhere, matched the site's "not found" text) are remembered for the number of
days set in Settings (default 14) so they are not requested again. A skipped URL is never silent: it is listed in "Last run" and in the log
("not re-checked: cached as not existing since DATE (reason)"). The entry is forgotten automatically when you visit that page, and
Settings -> Test your templates shows a warning on cached URLs in "Preview URLs"; "Check if they exist" removes the entry of every URL that
does exist. "Clear 'doesn't exist' cache" (History log) empties it; setting the days to 0 turns the cache off.

## Robot checks ("Confirm you are not a robot")
If a page you are collecting links from (Khan Academy, Google …) shows a robot check / CAPTCHA, you get a notification that stays until
dismissed ("BOT  Robot check – Khan Academy"), the tab is brought to the front, the toolbar icon shows BOT, and the run WAITS (Settings → "Robot check:
wait for me this long", default 180 s). Solve it and the search carries on by itself; the notification disappears. If it isn't solved in time, or the wait is 0,
that search is stopped, the site is left alone for the rest of the run, and the page you are on is still saved (badge +N!). With "plain request" mode the check
is recognised from the HTML and you are told to use "render in a background tab" for that website.

## Text fragments from your selection
Select text on the page before pressing the shortcut and the saved URL gets a text fragment, e.g.
`https://www.treccani.it/enciclopedia/regione_(Enciclopedia-della-Matematica)/#:~:text=punto%20interno`. Nothing selected = plain URL. Long selections
become `first words,last words`. Only the page you are on gets it (never the URLs found on related websites), and ID-property values never contain it.
Settings: global switch + per-website override (Advanced).

## Plural-tolerant URL matching in searches
In "URL contains the term" mode the singular/plural spelling of the last word is also accepted (term "one sided limit" finds `.../one-sided-limits-from-graphs-asymptote`).

## Redirects and spelling corrections
The address a page (or the Wayback Machine) ENDS on decides what is written: `Harmonic_Number` -> `Harmonic_number` is stored as `Harmonic_number` (value, URL and P1065).
Case/slash/www differences are always accepted. Real redirects (ProofWiki `Big_O_Notation` -> `Symbols:O/Big-O_Notation`) are skipped unless the website (or Settings) says
"accept"; an accepted redirect must stay on the website, match one of its templates and still be about the same page. MediaWiki wikis: "Use MediaWiki search" preset.

## Site access in one go
Settings -> "Allow all websites in one go…" asks Chrome once for access to every website (the extension still only contacts the ones you configured). "Remove all-websites
access" takes it away again (websites you allowed individually stay allowed).

## Website data file (e.g. ~/Nextcloud/data.json)
Settings -> "Website data file": "Create a file…" / "Use an existing file…" links a JSON file on your computer. While linked, the file is the source of truth: every run reads it,
"Save all" writes it (asking first if the file changed elsewhere), "Reload from file" re-reads it. A copy is always kept in the browser and used whenever Chrome has not (re)granted
access to the file (e.g. after a restart: "Re-grant access"); runs then say so in the last-run list and log. Optionally the Safety & politeness settings live in the file too.
Needs a Chromium browser with the File System Access API. History log, cache and debug logs stay in the browser.
