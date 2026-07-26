# Test harness

Regression suites for FretFind2D. Built to make dependency upgrades verifiable:
the vendored libraries in [../../src/libs/](../../src/libs/) had gone untouched
since 2010, and swapping any of them needs a way to prove nothing moved.

## Running

```
node test/harness/run.js
```

Needs **Node 22+** (for the global `WebSocket`) and **Chrome**. Nothing else —
no `package.json`, no `npm install`, matching the project's zero-build setup.
Chrome is looked up in the usual install locations; override with the `CHROME`
environment variable if it lives elsewhere.

Suites can also be run individually:

```
node test/harness/outputs.test.js
node test/harness/browser.test.js
```

## What each suite covers

**`outputs.test.js`** — no browser. `fretfind.js` is one IIFE that touches no
DOM at load time, so it runs in a bare `vm` context. Covers the unit
arithmetic, scale parsing and validation, the fret geometry, and every text
writer.

Its centrepiece is a **byte-for-byte hash comparison** against
`baseline.json`. SVG, DXF, HTML, CSV, TAB and the on-screen table all come out
of pure `ff` functions that never touch jQuery, Raphael or jsPDF — so swapping
any of those libraries must leave every hash identical. A changed hash is a
regression, not an improvement. When one does change the suite writes the
current outputs to a temporary directory so you can diff them.

Regenerate the baseline deliberately, only when output *should* change:

```
node test/harness/outputs.test.js --update
```

**`browser.test.js`** — drives the real page in headless Chrome over the
DevTools protocol. Covers what needs a DOM: unit conversion end to end,
permalink round-trips (including links written by older versions), the three
script-injection vectors reachable from the URL fragment, error reporting for
invalid input, string-count edge cases, absence of global leaks, the Raphael
drawing, the jsPDF writers, and it runs [../geom.html](../geom.html) too.

## Notes for anyone extending it

- Navigation always goes via `about:blank` first. Two URLs differing only by
  fragment are a same-document navigation, so the page would keep its state and
  `updateFormFromHash` would never run again — tests would pass for the wrong
  reason.
- `window.__errs` collects uncaught page errors, so "did it crash?" is a real
  assertion rather than an absence of evidence.
- `lib.js` holds a replica of `getGuitar()` for the single-scale case, because
  the real one lives in the UI layer and needs the DOM.

## What is not covered

That a PDF *looks* right. The page geometry is checked — the MediaBox must come
out identical in inches, centimetres and millimetres, since a design is the same
physical object however its numbers are written — but nothing verifies that the
lines inside it are in the right places, and that is what matters to someone
cutting a real fretboard. Verify it by hand: export a known scale length, open
the PDF, and measure it with print scaling disabled.
