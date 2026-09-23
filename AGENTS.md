<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# tilegen: instructions for coding agents

## Hard requirement: everything runs in the browser

tilegen is a static web page. The whole pipeline (SVG and image parsing,
geometry, meshing, 3MF/STL writing) runs in the user's browser tab, and it is
published as plain files on GitHub Pages.

- **No backend.** No server-side code, no API the page calls to do work, no
  upload of the user's artwork anywhere. "Nothing is uploaded" is a promise
  the README makes to users.
- **No build step.** The files in `webjs/` are what gets served. No bundler,
  no npm, no transpiling. Third-party code is loaded from a CDN at a pinned
  version (see `initManifold` in `webjs/src/pipeline.js`) or vendored.
- **No install for users.** Opening the Pages URL is the whole setup.

A new feature that cannot meet this is out of scope. Ask the user before
proposing anything that would break it.

### The one local server, and why it is not a backend

To run a local checkout, serve the repo with any static file server
(`python3 -m http.server 8790`, then open `/webjs/`). The server only hands
over files; it does no work. It is needed only because browsers refuse to load
ES modules from a `file://` URL. The published Pages site needs nothing local.

When telling the user how to try an unpushed change, say this plainly, so it
does not read as a server being part of the product.

## Tests

```bash
python3 webjs/tests/run.py      # headless Chrome, stdlib only
```

These tests run the real modules in a real browser, for the same reason. See
`webjs/tests/README.md` for why, and for what `expected.json` is (frozen
reference values: a new option must default to off in the suite's
`generate()` so those values still hold).

Bump the `?v=` cache-bust query in `webjs/index.html` / `webjs/tests/index.html`
when changing the modules they import.
