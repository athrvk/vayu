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
| Version | v0.18.0 (`QJS_VERSION_*` in `quickjs.h`) |
| Upstream commit | `d7215b0ad3fc2c562e8317fd9bca058fd4863804` (the `v0.18.0` tag, 2026-11-01) |
| First vendored | 2026-01-14 (`fee2e89b1`) |
| Current version since | 2026-11-01 (0.16.1 from 2026-10-21, `a42225c`; 0.16.0 from 2026-07-31, `f97fddb34`) |
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
| Version | 0.12.1 (`HDR_HISTOGRAM_VERSION` in `include/hdr/hdr_histogram_version.h`) |
| Upstream commit | `30e9ce6ef5dcdc60f9270e1ca03c0966eaaf71d0` (the `0.12.1` tag, 2026-10-16) |
| First vendored | 2026-01-24 (`3371c6ac7`) |
| Current version since | 2026-11-10 (0.11.8 from 2026-01-24, `3371c6ac7`) |
| Local patches | none |

The tree is byte-identical to the upstream tag for every file it holds. Left
out: `.github/`, `.clusterfuzzlite/` (CI configuration), `.claude/` (a Claude
Code skill for upstream's maintainers, which would load into sessions here)
and `test/vendor/`.

The build compiles seven of the library's sources (`engine/CMakeLists.txt`),
with the no-op log stub, so zlib and the packed-histogram codec
(`hdr_packed_histogram*.c`) are not linked. The AVX2 percentile scan needs no
build flag: `hdr_histogram.c` compiles it under a per-function
`target("avx2")` attribute and picks it at run time, on x86-64 GCC/Clang only
(never MSVC). Nothing here needs `libatomic`, which upstream links only where
64-bit atomics lower to library calls (32-bit ARM, RISC-V).

## Re-vendoring

1. Clone the new upstream tag and diff it against the tree here
   (`diff -rq <clone> engine/vendor/<name>`). The only differences should be
   the omitted paths above; anything else is a local change that needs a row
   in "Local patches" and an issue naming what retires it.
2. Replace the tree, update the version, commit and date in the table, and
   run the engine tests that cover the library (`script` for quickjs-ng,
   `metrics` for hdrhistogram).
