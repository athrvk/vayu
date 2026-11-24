#!/usr/bin/env python3
"""Stage 1: every table cell over 200 characters becomes a short cell plus a subsection (#3847).

Run from the repository root, with this directory on PYTHONPATH:

    git show 54ba46d51:docs/app/COMPONENTS.md > /tmp/orig.md
    git show 173f83152:docs/app/COMPONENTS.md > /tmp/stage1.md
    PYTHONPATH=scripts/split-components-md python3 scripts/split-components-md/reshape.py verify /tmp/orig.md /tmp/stage1.md

`reshape IN OUT` writes the reshaped page; `verify ORIG NEW` puts every moved cell
back and fails unless the result equals ORIG byte for byte.
"""
import re
import sys

from mdlib import scan, sentences, slug, table_cells, wrap_sentences

CELL_LIMIT = 200
LINK_RE = re.compile(r" \[Details\]\(#([^)]+)\)")

# Summaries keyed by the 1-based line of the row in the page before reshaping.
# None means: the cell's first sentence, verbatim.
AUTO = None
SUMMARY = {
    203: "`VariablesSection.tsx` - the variables this request references, with the in-scope set and a quick editor over them.",
    204: "`AuthContextSection.tsx` - the effective auth mode and where it came from, via the shared `resolveAuthSource` walk.",
    205: AUTO, 206: AUTO,
    207: "`GraphQLSection.tsx` - schema status and age, the endpoint, and an outline of the document's operations.",
    208: "`RecentSendsSection.tsx` - the last five design runs of this request, newest first, each opening that run in History.",
    214: "`CollectionVariablesSection.tsx` - the definitions this collection owns, editable through the request tab's commit path.",
    215: "`CollectionAuthSection.tsx` - this collection's auth mode and what a descendant set to Inherit would pick up.",
    217: "`CollectionLastRunSection.tsx` - how this collection's most recent run went: outcome, plan size and age, opening that run in History.",
    223: "`RunConfigSection.tsx` - mode, duration, target RPS, virtual users, iterations, ramp and protocol, from the run's `configSnapshot`.",
    224: "`RunSourceSection.tsx` - the environment the run used and a link opening the request it ran from.",
    365: AUTO,
    367: "One `ExternalChangeCallout` per conflicted field group (issue #1436); the four body-shaping fields collapse into one callout.",
    368: "The builder's half of the crumb line: the collection chain root-first, then the request name, drawn by the shared `TabBreadcrumb`.",
    369: "The URL bar: `index`, `MethodSelector`, `UrlInput`, `SendWithRowDialog`.",
    370: "`index` + `panels/`: the request editor's tab panels, `InfoPanel` first in the row.",
    371: "The response viewer: `index`, `StepUpNotice` + `step-up.ts`, `ResponseCookies` and the rest of its parts.",
    372: AUTO,
    373: "Warns when a duration-based load test would outlive an access token the engine will not renew mid-run.",
    374: "The table/text toggle above a `KeyValueEditor`, and the textarea it swaps in.",
    375: "Module hooks (`useHeadersManager`, `useVariableSupport`, `useOAuth2DeferredNames`) and the module's `utils/`.",
    399: AUTO,
    400: "Pure (Monaco-free) diagnostic computation: a syntax check without a schema, full validation with one.",
    401: AUTO, 402: AUTO, 403: AUTO,
    404: "Zustand store (`useSchemaCache`) keyed by `schemaCacheKey(target)`: the endpoint URL plus the credentials it is reached with.",
    405: AUTO,
    406: "Registers Monaco language providers for `graphql`: completion, hover, debounced diagnostics and formatting.",
    407: AUTO, 408: AUTO,
    409: "Zustand store for the explorer's view: whether the pane is open, and per schema the search text, expanded rows and scroll position.",
    410: AUTO,
    411: "Derives a JSON Schema from the query's `$variable` definitions and applies it to the variables editor.",
    412: "What a JSON editor's markers are computed from when its text may hold `{{token}}`s outside strings.",
    422: AUTO,
    423: "Where a drop lands in a one-dimensional list: `slotAt` and `landingIndex`.",
    424: "The 2px `--primary` line a drag draws at the edge it would drop on, `horizontal` or `vertical`.",
    475: AUTO,
    476: "Everything a row needs that is not the row itself, in three contexts split by how often the value changes (#2543).",
    477: AUTO,
    478: "The drag machinery: one set of pointer handlers on the `role=\"tree\"` element (`treeHandlers`, #2543).",
    479: "The per-row half of the drag machinery, shared by both row types: `useRowDnd`.",
    480: "The row menu's \"Move to…\": a tree-ordered picker of every collection the row may move into.",
    481: AUTO,
    482: "The tree as the rows a user can see (#2543): `flattenVisibleRows` lists them in order.",
    483: "Renders that list flat under `role=\"tree\"`, one wrapper per row, windowed (#2543).",
    484: "The window: which rows the drawer body can show plus ten rows of overscan each way.",
    486: "A collection (folder) row, wrapped in `memo` (#2543); everything but its entity and position comes from the contexts.",
    487: AUTO,
    488: "A row's actions and its menu's name, for both menus that show them (#2543).",
    489: "The tree's one right-click menu (#1360, #2543): the `role=\"tree\"` element is the only trigger.",
    490: AUTO, 491: AUTO,
    492: "What a parsed file lost or changed, as the lines the import preview and every batch ledger row show.",
    493: "The lines `importNotices` writes, drawn: amber for what the user finishes by hand, muted for what the import decided.",
    494: "What an import does once it is applied (issue #2109): `buildImportReport` and `announceImport`.",
    495: "The active environment after an import (issue #2115): `planEnvironmentActivation` and `activateImportedEnvironment`.",
    496: "Every `parentId` walk in the renderer: `walkAncestors`, `collectionPath`, `isDescendant` and the rest.",
    497: "`childrenOf(parentId, ...)`: a parent's sub-folders and requests as the one list the tree shows (#2535).",
    498: AUTO,
    499: "The arithmetic behind a drop: `planMove` turns a sibling list and a target index into the `POST /reorder` batch.",
    515: AUTO, 516: AUTO,
    517: "Extractors, assertions, timers and scripts on the collection, through the shared `ElementList` primitive (issue #1512).",
    519: "The declared **data contract** (issue #599): pick a file and its columns are declared onto `collection.dataSchema`.",
    520: "The bound **OpenAPI document** (issue #638): where it came from, when it was bound, and how many requests carry an operation.",
    611: "Run status, method and URL, stop button, and the config summary line.",
    612: "Orchestrator - composes the hero row, stat row, and charts per mode.",
    613: "Row 3 of the live view: the latency distribution and the request timing card, from the latest gate frame.",
    614: "Row 1.5 of the live view, for a **scenario load run** only (#2823): the sequence badge, iteration facts and a step table.",
    615: "Row 1.6 of the live view, for a **run whose frames carry `stream_events`** only (#3236): a \"Stream events\" card.",
    616: "Shared bits (Eyebrow/InfoChip) + centralized InfoChip wording + the `orDash()` / `fmtRate()` helpers.",
    765: "The \"Test config\" box: one line of mode, virtual users, the configured count, duration and protocol.",
    766: "The p99, total requests and success rate tiles at the top of the Overview tab, before the hero cards.",
    767: "The warning `Callout` over the Overview of a failed load run the engine could not fully record (#2895).",
    768: "Summary - opens on the `UnrecordedFiguresNotice`, then `RunKeyMetrics`, then the mode-adaptive `HeroRow` + `ModeStatsRow`.",
    769: "The Overview's **Error classes** card (#3828): the three MCP failure classes as tiles in a fixed order.",
    770: "The run's detected anomaly windows in words (`detectAnomalies`), plus any stretch the host spent asleep.",
    771: "Latency/throughput detail; the run-level phase averages card sits beside the per-phase percentiles.",
    772: "p95, throughput and error rate across the open run's request's or collection's runs, from the runs list's `resultSummary`.",
    773: "Sampled request/response pairs; the synthetic test-validation row is dropped here.",
    774: "Per-step latency and counts for a **scenario load run**; its element rows are the shared `ElementTally`.",
    776: AUTO, 777: AUTO,
    3331: "**muted, dashed underline**, never the accent of a resolved token; the popover opens as for a stored variable.",
}

# Headings for rows whose first column is not a usable name.
HEADING = {
    515: "Info tab (`InfoTab.tsx`)",
    516: "Auth tab (`AuthTab.tsx`)",
    517: "Elements tab (`ElementsTab.tsx`)",
    519: "Data tab (`DataTab.tsx`)",
    520: "Spec tab (`SpecTab.tsx`)",
    3331: "`{{token}}` named in `deferredVariables`",
}
# The long cell is not in column 2 for the two tables below; column index into
# table_cells() of the cell to move.


def split_cell(raw):
    stripped = raw.strip()
    lead = raw[: len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()) :]
    return lead, stripped, trail


def reshape(text):
    lines = text.split("\n")
    events = list(scan(lines))
    heading_idx = [i for i, kind, _ in events if kind == "heading"]
    level_of = {i: d[0] for i, kind, d in events if kind == "heading"}
    taken = {slug(d[1]) for _, kind, d in events if kind == "heading"}

    details = {}  # insertion heading index (or len(lines)) -> [(level, heading, text)]
    summaries_used = set()
    for i, kind, _ in events:
        if kind != "row":
            continue
        cells = table_cells(lines[i])
        long_cells = [j for j, c in enumerate(cells) if len(c.strip()) > CELL_LIMIT]
        if not long_cells:
            continue
        assert len(long_cells) == 1, (i + 1, "two long cells")
        j = long_cells[0]
        lineno = i + 1
        assert lineno in SUMMARY, f"no summary for line {lineno}"
        summaries_used.add(lineno)
        lead, body, trail = split_cell(cells[j])
        summary = SUMMARY[lineno]
        if summary is AUTO:
            summary = sentences(body)[0]
        title = HEADING.get(lineno)
        if title is None:
            assert j != 1, (lineno, "long cell is the name column")
            title = cells[1].strip()
        name = slug(title)
        assert name not in taken, (lineno, "heading collides", name)
        taken.add(name)
        cells[j] = f"{lead}{summary} [Details](#{name}){trail}"
        assert len(cells[j].strip()) <= CELL_LIMIT, (lineno, len(cells[j].strip()))
        lines[i] = "|".join(cells)
        before = [h for h in heading_idx if h < i]
        parent = level_of[before[-1]]
        after = [h for h in heading_idx if h > i]
        at = after[0] if after else len(lines)
        details.setdefault(at, []).append((min(parent + 1, 6), title, body))
    assert summaries_used == set(SUMMARY), set(SUMMARY) - summaries_used

    out = []
    for i in range(len(lines) + 1):
        if i in details:
            # Insert before the trailing blank lines that precede the next heading.
            k = len(out)
            while out and out[k - 1] == "":
                k -= 1
            block = []
            for level, title, body in details[i]:
                block += ["", "#" * level + " " + title, "", *wrap_sentences(body)]
            out[k:k] = block
        if i < len(lines):
            out.append(lines[i])
    return "\n".join(out)


def unshape(text):
    """Rebuild the pre-reshape page from a reshaped one."""
    lines = text.split("\n")
    events = list(scan(lines))
    heading_idx = [i for i, kind, _ in events if kind == "heading"]
    by_slug = {slug(d[1]): i for i, kind, d in events if kind == "heading"}
    drop = set()
    for i, kind, _ in events:
        if kind != "row":
            continue
        cells = table_cells(lines[i])
        for j, c in enumerate(cells):
            m = LINK_RE.search(c)
            if not m:
                continue
            h = by_slug[m.group(1)]
            nxt = next((x for x in heading_idx if x > h), len(lines))
            body = lines[h + 1 : nxt]
            while body and body[-1] == "":
                body.pop()
            assert body[0] == ""
            text_ = " ".join(body[1:])
            lead, _, trail = split_cell(c)
            cells[j] = lead + text_ + trail
            lines[i] = "|".join(cells)
            start = h - 1  # the blank line the reshape inserted
            assert lines[start] == ""
            drop.update(range(start, h + 1 + len(body)))
    return "\n".join(line for i, line in enumerate(lines) if i not in drop)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "reshape":
        open(sys.argv[3], "w").write(reshape(open(sys.argv[2]).read()))
    elif cmd == "verify":
        orig = open(sys.argv[2]).read()
        rebuilt = unshape(open(sys.argv[3]).read())
        if rebuilt != orig:
            sys.exit("NOT IDENTICAL")
        print("identical", len(orig))
