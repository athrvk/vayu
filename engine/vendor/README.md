# Vendored libraries

Source trees committed into the repository because no package manager owns
them. Dependabot has no C ecosystem, vcpkg does not manage these two, and
CodeQL skips `engine/vendor`, so nothing alerts on an upstream security fix:
the release checklist (`.claude/skills/releasing/SKILL.md`, step 3) is the
mechanism. Each section is the record to compare against.

The vendored JavaScript libraries (`ajv`, `chai`, `csv-parse`, `lodash`,
`moment`, `tv4`, `uuid`, `xml2js`) are not repeated here. Each has its own
`README.md` and an entry in `js-manifest.json`; see "Vendored JavaScript
libraries" in `docs/engine/building.md`.

## quickjs-ng

| | |
|---|---|
| Upstream | <https://github.com/quickjs-ng/quickjs> |
| Version | v0.16.1 (`QJS_VERSION_*` in `quickjs.h`) |
| Upstream commit | `954dc53628e36891f93c359aa60895c2ae3dac6b` (the `v0.16.1` tag, 2026-08-04) |
| First vendored | 2026-01-14 (`fee2e89b1`) |
| Current version since | 2026-10-21 (`a42225c`; 0.16.0 from 2026-07-31, `f97fddb34`) |
| Local patches | none |

The tree is byte-identical to the upstream tag for every file it holds. Left
out: `.github/`, `.gitignore` and `test262/`. The one local patch the tree
ever carried (a linear-time line-start tracker, #2657) was retired by the
0.16.1 upgrade, which ships the same fix. `script_parse_position_test.cpp`
guards it, so a re-vendor that loses it fails a test.

## hdrhistogram

| | |
|---|---|
| Upstream | <https://github.com/HdrHistogram/HdrHistogram_c> |
| Version | 0.11.8 (`HDR_HISTOGRAM_VERSION` in `include/hdr/hdr_histogram_version.h`) |
| Upstream commit | `8dcce8f68512fca460b171bccc3a5afce0048779` (the `0.11.8` tag, 2023-04-28) |
| First vendored | 2026-01-24 (`3371c6ac7`) |
| Local patches | none |

The tree is byte-identical to the upstream tag for every file it holds. Left
out: `.github/` and `test/vendor/`.

## Re-vendoring

1. Clone the new upstream tag and diff it against the tree here
   (`diff -rq <clone> engine/vendor/<name>`). The only differences should be
   the omitted paths above; anything else is a local change that needs a row
   in "Local patches" and an issue naming what retires it.
2. Replace the tree, update the version, commit and date in the table, and
   run the engine tests that cover the library (`script` for quickjs-ng,
   `metrics` for hdrhistogram).
