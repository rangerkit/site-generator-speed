[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rangerkit/site-generator-speed/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rangerkit/site-generator-speed/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

# Site Generator Speed

A fast, dependency-free drop-in for **makefun-site 1.0.0**, make.fun's own
static site generator, written for the
[Site Generator Speed](https://make.fun/competitions/site-generator-speed-01-run-20261122)
competition (`site-generator-speed-01-run-20261122`).

`run(input)` in `solve.js` returns exactly what makefun-site 1.0.0's `build`
returns for every `{ site, templates, files }` input — the whole output tree
(each page's `index.html`, the index and tag pages, `build-report.txt` and
each static file) as a JSON object of path to file text, byte for byte. That
includes the dialect's own front matter (its seven keys, its refusal reasons
and their order), its Markdown subset (fences, headings with unique slug ids,
blockquotes, flat lists, paragraphs, and the inline code/strong/emphasis/link
rules with backslash escapes), its template dialect (`{{ }}`, `{{{ }}}`,
`{% for %}`, `{% if %}`, `{% include %}`, standalone-tag lines), its slug rule
(NFKD, combining marks dropped, 64-character cut), its link resolution and
broken-link reporting, and the sorted build report. `main.ts` is the house
driver, unchanged: it reads `/input/cases.json`, answers each case alone with
`run`, and writes `/output/answers.json`. No state is kept between calls —
every cache lives inside a single `run`.

## Speed

The reference is a straightforward plugin pipeline; this entry reproduces its
output with a leaner engine:

- **Single-pass scanners instead of per-line regexes.** Front matter,
  Markdown block classification (fences, headings, breaks, list markers) and
  template tag recognition are hand-written code-unit scanners, so the common
  line costs a few comparisons instead of several regex matches.
- **Fused Markdown rendering.** Blocks are lexed and rendered in one pass
  over the body's lines — no token objects are built. Inline rendering jumps
  between special characters with a single regex scan and writes plain runs
  verbatim, instead of escaping character by character; nested strong,
  emphasis and link spans recurse only over their own slice.
- **Per-case caches.** Slugification (NFKD normalisation is the expensive
  step), long dates and link resolution are memoised in Maps that live for
  one `run` call: tag names, dates and link targets repeat heavily across a
  site's hundreds of pages. ASCII slugs take a fast path that skips
  normalisation entirely.
- **Cheap text work.** HTML escaping returns the input untouched when it
  holds no special character; word counting for `reading_minutes` is one
  code-unit scan; template rendering appends into a shared parts array and
  joins once per page, and templates are parsed once per case, not per page.

Verified locally against the kit's practice set: all 3 cases byte-identical
to the reference under the scorer's comparison, deterministic across runs,
and several times faster than the house baseline on the same machine.
