# Quick Label Reference

A cheat sheet for applying labels to Vayu issues and PRs.

## Component (Auto-Applied, Don't Manual Apply)

```
component:app          → UI (Electron + React)
component:engine       → Engine (C++20, HTTP, scripting)
component:database     → Database (schema, persistence)
component:ci           → GitHub Actions, CI config
component:build        → Build system, versioning
```

## Area (Engine Sub-Areas, Auto-Applied)

```
area:http              → HTTP server, routes, SSE
area:auth              → OAuth2, authentication
area:metrics           → Metrics, statistics
area:scripting         → QuickJS runtime, pm.* API
```

## Type (Manual, Pick One)

```
type:bug               → Fixing broken behavior
type:feature           → New user-facing feature
type:enhancement       → Improving existing feature
type:perf              → Performance improvement
type:test              → Tests, benchmarks
```

## Status (For PRs, Manual)

```
status:needs-review    → Ready for review
status:blocked         → Waiting on something
status:ready-merge     → Approved, ready to merge
```

## Priority (For Issues, Manual)

```
priority:critical      → Urgent, blocks work
priority:high          → Important
priority:low           → Nice-to-have
```

## Special

```
documentation          → Docs, guides, examples
good first issue       → Good for newcomers
help wanted            → Need outside expertise
severity:blocking      → Breaking change
breaking-change        → Breaking change (synonym)
dependencies           → Dependency updates
duplicate              → Issue already exists
wontfix                → Won't be addressed
invalid                → Not applicable
flaky                  → Flaky test
memory-leak            → Memory leak
performance            → Performance issue
scripting              → QuickJS-related
correctness            → Logic error
```

## Example Workflows

### Labeling an Issue

1. Add one `component:*` (or let auto-apply if PR)
2. Add one `type:*` (manually)
3. Add `priority:*` if urgent (manually)
4. Add `area:*` if engine issue in a sub-area (auto-apply)
5. Add special labels as needed

### Labeling a PR

1. Auto-applied: `component:*`, `area:*`
2. Manually add: `type:*`
3. Manually add: `status:*` (needs-review, ready-merge)
4. Add special labels as needed

## Colors at a Glance

- 🟠 **Warm (Orange/Red):** Critical, important, urgent, blocking
- 🔵 **Cool (Blue):** App, features, enhancements
- ⚪ **Gray:** Infrastructure, areas, build, CI
- 🟢 **Green:** Ready, success, low priority
- 🟣 **Purple:** Features, help wanted
- 🔵 **Teal:** Testing, good first issues

## Need Help?

- Full docs: `.github/LABELING.md`
- Migration guide: `.github/LABEL-MIGRATION-GUIDE.md`
- Label setup script: `.github/scripts/setup-labels.py`
