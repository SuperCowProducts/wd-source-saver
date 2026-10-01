# Wikidata Source Saver

1. Unzip, open chrome://extensions, enable Developer mode, "Load unpacked", pick this folder.
2. Make sure you're logged in to wikidata.org in the same browser profile.
3. Open the extension's Options (right-click icon → Options) and add websites: domain → Wikidata item of the website.
4. Copy a Wikidata item (Qxxx or its URL), browse to a page on a configured website, press Alt+Shift+S (change at chrome://extensions/shortcuts) or click the toolbar icon.

Result: item gets  P1343: <website item>  with qualifier  P2699: <page URL>.
- Same website + same URL already present -> nothing is written.
- Statement for that website exists without a URL -> the URL qualifier is added to it.
- Otherwise a new statement is created.
If the page's domain isn't configured, the settings page opens pre-filled with the domain.
