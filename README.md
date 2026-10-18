# Wikidata Source Saver 2.0

Install: chrome://extensions -> Developer mode -> Load unpacked (or Reload). Be logged in to wikidata.org.

## Use
1. Copy a Wikidata item or lexeme: `Q42`, `L1234` or its URL (the clipboard must START with the entity; pasted JSON/other text is rejected).
   Lexemes work the same way as items; a form (`L1234-F1`, or `…/Lexeme:L1234#F1`) or a sense (`L1234-S1`) is edited directly, so the
   statements land on that form/sense.
   Optional extra terms after it, separated by commas, semicolons or new lines; several words per term are fine, and a
   language tag applies to the terms after it:  `Q123, en: Pythagorean theorem, it: teorema di Pitagora`
   (terms before any tag go to every website).
2. Open a page on a configured website, press Alt+Shift+S (or click the icon).
   Alt+Shift+A = this page only. Alt+Shift+X = stop. A run in progress ignores repeated shortcuts;
   the toolbar badge shows progress (blue %), clicking the icon during a run stops it.

## What it does
* Terms come ONLY from the page's own ID and the extras you type. Wikidata labels and aliases are never used. Nothing is
  guessed; terms with symbols/formulas/>6 words are dropped. For a run-together ID (PythagoreanTheorem) the words are read
  from the capitals, or from a matching extra. An all-lowercase run-together ID on an English site (investopedia `incomestatement`)
  is split with a bundled English word list (`wordlist-en.js`, ~60k most frequent words, Viterbi on word frequency): it becomes
  "income statement". If any part is not a known word, or the split leaves tiny fragments (ebitda -> eb it da), it is left
  alone, and a matching extra always wins. Each website has a language list and only receives terms in its language(s)
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

### Categories that follow the URL
The Categories field may contain a `{a|b}` group. It follows the `{x|y}` choice of the template that matched the current page, by position.
With the template `https://www.ebsco.com/research-starters/{economics|mathematics}/{id}` and categories `{ec|mt}, research`, a page under
`/economics/` searches the websites in `ec` + `research`, a page under `/mathematics/` those in `mt` + `research`. If the page matches no
template (or the group and the choice have a different number of options) every alternative is used. For OTHER websites a group simply means
"belongs to all of them". The category actually used shows in the debug log ("matched website … categories") and the choice in "ID read from the URL".

### YouTube videos
On a video page (`/watch`, `/shorts`, `/live`) the URL only holds the video ID, but the channel's handle is embedded in the page. The page is
read (the channel link under the video, then the embedded author data, then the player data) and Wikidata is asked which item has
**YouTube handle (P11245)** = that handle (with or without `@`, as typed or lower-case). That channel item becomes the value of
`P1343` and the video goes in as the qualifier **`P1651` (YouTube video ID)**: `P1343: <channel item>` + `P1651: <video ID>` (no P2699 URL, and nothing is saved as a separate P11245/P1651 statement).
Video IDs behave like URLs do for other websites: they go into the item's existing P1343 statement for that channel (which may also hold P2699
URLs, e.g. a website with its own content that also has a YouTube channel), or several new ones share ONE new statement, so two videos of the
same channel are not split into two P1343. A video ID that is already there counts as "already there", and a Wayback link is only attached to a
statement that holds exactly that one ID. If the handle isn't on the page, no item has it, or several do, the page is saved the way the website is configured and the
reason is listed under "not saved". Editing the URL in the review window re-reads the video ID from it. A video ID is not a word, so it is not
searched for on other websites (your typed extras still are).

### Singular / plural in searches
Websites with "plural / singular forms" ticked are now searched with both numbers of the main noun, not only the page's own spelling
("financial statements" and "financial statement"; at most 4 queries per website).

### Editing a URL
Every row with an address has an "edit URL" button. The typed address is checked as you type: it must be an http(s) URL; for an ID
row (a template with a property) the ID is re-read from it and shown (`→ P10715: i/income-statement`), and an address that matches none of the
website's templates is refused (the field turns red and Save is disabled). A warning appears if the host differs from the original.
On Save the old Wayback link is dropped and looked up again for the new address (when the website has "archive" on), the row is compared with
the item again (so it may turn out to be "already there"), and the history log records the edited address. The edited address is
**not** fetched to see if the page exists, and the website's URL mode (strip query/fragment) is not applied: it is saved exactly as typed.
"undo" restores the original.

### Sending rows to other items / lexemes
Each row has a "goes to:" field (empty = the item above). Type or paste `Q123`, `L123`, `L123-F1` / `L123-S1` or a wikidata.org URL;
a short name of the target is shown next to it so a typo is easy to spot. Nothing is retyped twice:
* the bar at the top takes a target once and sets it on **ticked rows**, **all rows**, or (via the "→ Q123" button that appears on each row)
  on any single row; "reset all" sends everything back to the main item;
* the field offers the main item and the items/lexemes you saved to before (from the history log) as suggestions.
On Save the rows sent elsewhere are compared with THAT entity (so "already there" and the shared P1343 statement are worked out for it) and saved
in one edit per target; each edit obeys the edit-rate limits and "max per edit". The Save button shows the split (`Q42: 3, Q99: 2`), the
history log records every row under the entity it went to, and if a later edit fails what was already saved is listed in the message.

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
In "URL contains the term" mode the singular/plural spelling of the main noun is also accepted (term "one sided limit" finds `.../one-sided-limits-from-graphs-asymptote`).
The main noun is the last word, or the word before "of / for / in / on / to / with / from / by / per / at / and" (term "economy of scale" also tries `economies-of-scale`).

## Redirects and spelling corrections
The address a page (or the Wayback Machine) ENDS on decides what is written: `Harmonic_Number` -> `Harmonic_number` is stored as `Harmonic_number` (value, URL and P1065).
Case/slash/www differences are always accepted. Real redirects (ProofWiki `Big_O_Notation` -> `Symbols:O/Big-O_Notation`) are skipped unless the website (or Settings) says
"accept"; an accepted redirect must stay on the website, match one of its templates and still be about the same page. MediaWiki wikis: "Use MediaWiki search" preset.

## Site access in one go
Settings -> "Allow all websites in one go…" asks Chrome once for access to every website (the extension still only contacts the ones you configured). "Remove all-websites
access" takes it away again (websites you allowed individually stay allowed).

## Data file = your whole environment (e.g. ~/Nextcloud/data.json)
Settings -> "Website data file": "Create a file…" / "Use an existing file…" links one JSON file on your computer. It holds **everything you configured or accumulated**:
the websites, all settings, the blocked sites, the history log (what was saved / already present, per item) and the "page doesn't exist" cache.
**Restoring** on a new browser/computer: install the extension, Settings -> "Use an existing file…" -> pick the file. A summary tells you what will be loaded (websites, settings, N blocked sites, N history records, N cached misses); after you confirm, the environment is exactly as it was.
(Chrome's permission to open websites is the one thing a file can't carry: press "Save all" once afterwards.)
* While linked, the file is the source of truth: every run reads it. It is **kept up to date automatically**: after each run (new history records are *merged* into the file, so another computer's records are not lost),
  when a site is blocked in the review window (merged), when you press "Save all" (writes everything), and when you clear/forget/import history or clear the cache in Settings (those *replace* the part, so a cleared log stays cleared).
* "Write everything to the file" writes the browser's current state into the file on demand; "Reload from file" re-reads it (asking first). Saving asks first if the file was changed elsewhere (Nextcloud sync).
* A copy is always kept in the browser and used when Chrome has not (re)granted access to the file (e.g. after a restart: "Re-grant access"). If a write to the file fails, the browser copy is flagged as newer: the run report and notification
  say so, the stale file never overwrites it, and "Write everything to the file" (or the next successful write) brings the file up to date. A file that can't be read as a data file is never overwritten automatically.
* Files from older versions (websites, optionally settings) still load: whatever they lack keeps the browser's copy and is written into the file when you connect it.
* Not in the file (not configuration): the debug log, the last-run report and the edit-rate counters (hourly limit). Needs a Chromium browser with the File System Access API.

## Configure a website from Wikidata (clipboard)
Copy an item or property the way Wikidata shows it in its heading and run the extension on a page that isn't configured yet:

* `Harvard Business School Online (Q133732538)` -> a new website with Name + Website item, and (from the item's "official website" P856) the URL template `https://online.hbs.edu/{path}`.
* `Investopedia term ID (P10715)` (or just `P10715`, or its Property: URL) -> Name + Default ID property, and (from "formatter URL" P1630) the template `https://www.investopedia.com/terms/{id}.asp` (`$1` becomes `{id}`).

Settings opens with the website filled in but NOT saved: add a category, check the template, press "Save all". If the website is already configured, only the missing templates are added.
Without a URL on Wikidata the Match field is filled from the page you are on. Preferred-rank values win; deprecated ones are ignored; at most three URLs are used.
A bare `Q123` on an unknown page is still treated as the item to save on (settings open with just the host). To pre-fill from a bare item (or from any page, known or not) use the
"configure a website" shortcut (Alt+Shift+C). "Label (Q123)" pasted from a heading also works as the item to save on, on configured pages.
Note: the formatter's `$1` becomes the single-segment `{id}`; if the property's values contain slashes (e.g. `f/financial-statements`), edit the template to `{path}` or use a value pattern.

## IDs that are inside the page, not in the URL
Some websites put the slug in the URL but keep the real ID in the page (e.g. `…/dictionary/automobile_adj`, ID `8269459060` inside). Settings -> website -> Advanced ->
**ID from the page**: one "place" per line, the first that yields a value wins:

    meta NAME [| regex]             <meta name|property|itemprop="NAME" content="…">
    css SELECTOR [@attr] [| regex]  text (or attribute) of the first element matching the selector
    jsonld KEY [| regex]            value of KEY anywhere in the page's JSON-LD blocks
    html REGEX   (or just REGEX)    regular expression over the HTML source; group 1 = the ID (no group = whole match)

`| regex` narrows what was found (group 1, or the whole match). Examples: `meta citation_doi | /(\d+)$`, `css link[rel=canonical] @href | (\d+)`, `jsonld identifier`, `html "entryId"\s*:\s*"?(\d+)`.
* Give the website an ID property and a template as usual (`P1234 https://example.org/dictionary/{id}`): the template reads the WORDS from the URL (for searching other websites);
  the **value** stored in the property comes from the page. An "ID value pattern" may use `{id}` for the value read (e.g. `OED-{id}`).
* The page you are on is read from the open tab. URL guesses on other websites and search results that belong to such a website are fetched and read the same way
  (one extra request per page, same politeness rules). Tick **send my browser's cookies** for logged-in/subscription sites. An edited address in the review window is re-read when you save.
* From a web.archive.org snapshot, or when the page can't be fetched, nothing is saved for it (the slug is never stored as the ID); the reason is listed under "not saved".
* If no line matches, the debug log shows snippets around long numbers on the page, so a line can be written.

## Confirming the search term
Before other websites are searched, a small window asks which term to look for, because a URL's words are often not the term
(`…/research-starters/political-science/bipartisanship-overview/` -> you probably want `bipartisanship`). The field is pre-filled with the text you had selected on the page, else the URL's words;
press Enter to accept. **Skip** (or Esc) saves the page without searching other websites at all. The setting **Confirm the search term** (Settings) can be `always` (default),
`only when the URL template has no {id}` or `never`.
* Templates without `{id}` (e.g. `https://www.bankofcanada.ca/{path}/`, …/2026/02/what-is-money/) have no single term in their URL, so their words are never searched unasked: the terms you typed on the clipboard
  (`Q123, money`) are used, and when there are none you are asked (whatever the setting, except `never`).
* Terms typed on the clipboard are always searched in addition (shown in the window); they don't make the question go away for an `{id}` URL.
* Asked only when other websites would actually be searched (related websites on, the page has a category, not a "save this page only" run).
* The text-fragment feature is unchanged: with it enabled, the selected text is still added to the saved URL as `#:~:text=…`.

## Finding other sources with ONE verbatim Google search
Settings -> **Finding other sources**: `ask every website of the category` (default: URL guesses + each website's own search) or
`one verbatim Google search per term`. In Google mode no website is asked one by one: for each term (the confirmed page term and up to two terms typed on the clipboard)
a background tab opens Google's **Verbatim** search (`tbs=li:1`: no synonyms, no spelling "corrections", no dropped words), accepts the cookie banner and reads
**Google result pages to read** pages (1-5, about 10 results each). Press "Save all" once after switching, so the extension may open google.com.
Every result page then lands in the review window (which always opens in this mode):
* a result from **a website you have configured**, in the page's category -> **ticked** (its ID is read with that website's templates, like any other result);
* a result from a website you have configured but in **another category** -> listed, **not ticked**;
* a result from **a website that is not in your settings** -> listed, **not ticked**. Tick it and type the **website item** (Q...) of the site/publisher - Save stays disabled until you have.
  "Also add this website to Settings" (on by default) opens Settings afterwards with it pre-filled (name, Q, domain, the page's category); press "Save all" there and the website is ticked automatically next time.
The Google link text is shown under each row to help you decide. Google's own links, ads and wikidata.org are ignored; at most 30 unknown-website results are listed.
A Google CAPTCHA stops the search and shows the usual notification (solve it in a normal tab). The other options (confirming the term, the per-edit limit and its exception, text fragments) work as before.

## Blocking sites
In the review window every row has a **block example.com** button (also on Google rows from unknown websites). Pressing it greys out, unticks and disables all rows of that site; press again to undo.
The site is added to the block list when the window is closed with **Save or Cancel** (closing it with the window's X changes nothing).
Settings -> **Blocked sites** is the same list as plain text (one site per line, `example.com` also blocks `www.` and subdomains, a pasted URL is cut down to its site, `#` comments); it is saved with "Save all".
A blocked site is left out *before* anything is requested or shown (URL guesses, site searches, Google hits, redirects that end up there). The page you are on is never blocked.
You are still told: the review window shows "Left out because of your block list: example.com (3)", the run report lists every left-out page (`⛔ blocked site …`), and the notification
says how many results were left out and from which sites (and which sites you just blocked). The list is part of the data file (and of the browser copy).

## No review timeout
The review window (and the term and Wikidata-lag questions) wait for you as long as you like, like an open document: no timer closes them. They end when you submit, cancel, close the window, or press Stop (which also closes them).
Nothing is written to Wikidata before you submit. After you submit, the script's own limits apply again (waiting between edits, search timeouts, ...).
If the window was open for more than a minute, the ticked rows are compared once more with the current item before saving, so a statement added or changed by someone else in the meantime is neither overwritten nor duplicated;
anything that is already there by then is reported as "already present".
