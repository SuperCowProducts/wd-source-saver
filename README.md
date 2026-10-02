# Wikidata Source Saver 1.3

1. chrome://extensions → Developer mode → Load unpacked → pick this folder (or click Reload after updating).
2. Be logged in to wikidata.org in the same Chrome profile.
3. Options (right-click icon → Options): add websites.
   - Website item: Wikidata item of the website (P1343 value).
   - Category: websites with the same category are searched together (e.g. "law").
   - URL templates: one per line, {id} = the term, e.g.
       https://www.law.cornell.edu/wex/{id}
       https://dictionary.nolo.com/{id}-term.html
   - {first} / {FIRST} = first letter of the ID (lower/upper case), e.g.
       https://www.mathwords.com/{first}/{id}.htm
       https://www.investopedia.com/terms/{first}/{id}.asp
     IDs starting with a digit/symbol can map to a folder such as "0-9" (Advanced).
   - Separator / letter case: how words of a multi-word term are written in that site's IDs
     (use of force -> use_of_force on one site, use-of-force on another).
   - Press Save and allow access to the listed websites (needed to check pages exist).
4. Copy a Wikidata item (Q123 or URL), open a page on one site, press Alt+Shift+S (or click the icon).
   Alt+Shift+A saves only the current page.

Websites with their own Wikidata property: fill "ID property" (e.g. P2812 for
https://mathworld.wolfram.com/{id}.html, separator none, case Title). The ID is saved as  P2812: MonotonicFunction
instead of the P1343/P2699 pair; the website item is then optional. With separator "none", CamelCase IDs are split
into words when searching other sites.

Choice groups: {a|b|c} in a template tries every choice, e.g.
   https://mathsisfun.com/{algebra|data|geometry|numbers|puzzles|money|calculus|physics|games|measure|activity}/{id}.html
Every choice whose page exists is added; when reading a page the choice is accepted whatever it is.
Plurals: tick "Also try plural / singular forms" on a site to also check polynomial <-> polynomials (English
guesses on the last word: -s/-es/-ies, matrix/matrices, analysis/analyses, ...). Misses are cheap (checked, then skipped).

Unreliable sites (often down, e.g. encyclopediaofmath.org): tick "always add the latest Wayback Machine snapshot".
The latest HTTP-200 capture is looked up via the Wayback CDX API and added as qualifiers
P1065 (archive URL) and P2960 (archive date) on the statement; a page counts as existing if the live page OR
a snapshot exists (so it works while the site is down). Existing statements that lack P1065 get it added.
If you are viewing https://web.archive.org/web/<timestamp>/<url> the original URL is matched against your sites and
that very snapshot is used.

Extra terms (several IDs for one item): copy "Q123, use of property, possession" - the item first, extra terms after.
Every term is tried on every template of every site in the category.
Sites can have several templates; every page that exists is added.

Result per page: P1343: <website item> with qualifier P2699: <URL>.
- Already present (same website + URL, ignoring http/https, www, trailing slash) -> skipped; yellow "=" badge if nothing new was added.
- Statement for that website without a URL -> qualifier added to it.
- Otherwise a new statement. All new statements go in one edit.
Settings has a template tester and a "Last run" log (what was added, present, or skipped and why).
