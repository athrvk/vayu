#!/usr/bin/env python3
"""
Splits the engine's single API reference page into the pages of docs/engine/api-reference/
(#3849), re-aims every link to it, and proves the move lost nothing.

The source is the page as it stands at --rev (default origin/master), read from
git, so the script reruns after the page is gone. Rerun it against the tip just
before merging: edits made to the old page since the last run are carried, not
lost.

What the move changes, and nothing else:

  - the page boundaries (MARKERS below say where each section goes);
  - a page title and front matter, and the index's table of pages (new text);
  - heading levels: a page promotes its first heading to the title where it has
    one section, and every heading on the page moves up by the same amount;
  - one sentence per line in prose (a paragraph's line breaks are replaced by a
    break after each sentence; tables, fenced code, headings and quotes are
    copied as they are);
  - link targets: a relative target gains `../` because a page moved down a
    directory, a `#fragment` that now lives on another page gains that page's
    name, and a link in any other page to the old page is aimed at the new one.

No prose is edited. An anchor never changes, so a fragment that named a
heading still names it.

Modes:

  (none)    write the pages and re-aim the links in the other markdown files
  --check   fail when a committed page, or a link to the old page, differs from
            what a run would write
  --verify  prove the committed pages hold the source's text: undo the title,
            the heading levels and the link targets, collapse whitespace, and
            compare with the source's sections; every old anchor must appear
            exactly once
  --render  render each page and its sections with the site's Markdown and
            compare the tags and text (needs requirements-docs.txt installed)

To rerun it just before merging, with the old page's conflict resolved by
deleting it: `python3 scripts/docs-split/split-api-reference.py --rev origin/master`,
then `--verify`, `--render` and `mkdocs build --strict -f .github/mkdocs.yml`.

Usage: split-api-reference.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import argparse
import posixpath
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

# The page was docs/engine/<NAME>.md; its pages are docs/engine/<NAME>/.
NAME = "api-reference"
SOURCE_PATH = f"docs/engine/{NAME}.md"
OUT_DIR = f"docs/engine/{NAME}"
NAV_FILE = ".github/mkdocs.yml"

# Each marker starts a section, which runs to the next marker. `line` is matched
# against a whole source line outside fenced code, in source order. A page may
# own several sections; they keep their source order on the page.
MARKERS = [
    ("---", "index"),
    ("## Who may call the API", "index"),
    ("## Request bodies", "index"),
    ("## Removed route aliases", "index"),
    ("## Resource writes: create vs update", "resource-writes"),
    ("### The request `body` union", "request-body"),
    ("### Behavior change (pre-1.0)", "resource-writes"),
    ("## Health & Configuration", "health-config"),
    ("## Workspace", "health-config"),
    ("## Collections", "collections"),
    ("## Requests", "requests"),
    ("## Elements", "requests"),
    ("## Trash", "trash"),
    ("## Request examples", "examples"),
    ("## Specs", "specs"),
    ("## Reorder", "collections"),
    ("## Import", "import"),
    ("## Export", "export"),
    ("## Environments", "environments"),
    ("## Global Variables", "environments"),
    ("## Change feed", "changes"),
    ("## Cookies", "cookies-and-certificates"),
    ("## Client certificates", "cookies-and-certificates"),
    ("## Allowed folders (file roots)", "file-access"),
    ("## Picked files (file grants)", "file-access"),
    ("## Transport diagnostics", "cookies-and-certificates"),
    ("## Webhook Inbox", "inbox"),
    ("## Mock Server", "mock-server"),
    ("## Authentication", "authentication"),
    ("## Execution", "execute"),
    ("### POST /compose", "compose"),
    ("### POST /execute", "execute"),
    ("### POST /runs", "load-runs"),
    ("#### Scenario runs", "scenario-runs"),
    ("#### Scenario load runs", "scenario-load"),
    ("## Metrics & Statistics", "metrics"),
    ("### GET /runs/:runId/live", "live-metrics"),
    ("## Runs", "runs"),
    ("### Per-step verdicts in a collection run", "collection-runs"),
    ("### GET /runs/:runId/samples", "runs"),
    ("## Scripting", "scripting"),
    ("## HTTP Status Codes", "index"),
    ("## Notes", "index"),
]

# The extensions the site renders pages with (.github/mkdocs.yml), less the ones
# that only restyle: what `--render` needs to read the same structure.
RENDER_EXTENSIONS = [
    "admonition", "attr_list", "def_list", "footnotes", "md_in_html", "tables", "toc",
    "pymdownx.details", "pymdownx.superfences", "pymdownx.inlinehilite", "pymdownx.tabbed",
]

# The index lists the pages just before this section.
PAGES_TABLE_BEFORE = "## Who may call the API"

# name -> (title, description, routes, route files). A title of None promotes the
# page's one heading to the title; the page's headings then move up with it. A
# page with a title of its own keeps its headings' levels, less `SHIFT` where
# its sections started deeper than a second-level heading.
PAGES = {
    "index": (
        None,
        None,
        "Conventions, errors, who may call the API, request bodies, removed aliases, status codes",
        "`server.cpp`, `http/`",
    ),
    "resource-writes": (
        None,
        "How a create or an update of a saved record behaves on every resource: ids, If-Match, "
        "the null-vs-absent rule, ordering, paged lists, accepted field shapes and auth modes.",
        "Every create and update",
        "`routes/collections.cpp`, `requests.cpp`, `environments.cpp`",
    ),
    "request-body": (
        None,
        "The request `body` union a stored request and a send carry: every mode, its fields and "
        "what the engine accepts.",
        "`body` of a request",
        "`routes/requests.cpp`, `execution.cpp`",
    ),
    "health-config": (
        "Health, configuration and workspace",
        "The engine's health, shutdown, configuration and request-default routes, and the "
        "workspace backup route.",
        "`/health`, `/shutdown`, `/config`, `/request-defaults`, `/workspace/backup`",
        "`routes/health.cpp`, `config.cpp`, `workspace.cpp`",
    ),
    "collections": (
        "Collections and reorder",
        "The collection routes - list, create, update, delete - and the reorder route that moves "
        "collections and requests among their siblings.",
        "`/collections`, `/reorder`",
        "`routes/collections.cpp`, `reorder.cpp`",
    ),
    "requests": (
        "Requests and elements",
        "The saved-request routes - list, read, create, update, delete - and the element-kind "
        "catalogue.",
        "`/requests`, `/elements/kinds`",
        "`routes/requests.cpp`, `elements.cpp`",
    ),
    "trash": (
        None,
        "The trash routes: what a delete leaves behind, how to list it, restore it or purge it.",
        "`/trash`",
        "`routes/trash.cpp`",
    ),
    "examples": (
        None,
        "The routes for a request's saved examples - list, create, update and delete.",
        "`/requests/:id/examples`",
        "`routes/examples.cpp`",
    ),
    "specs": (
        None,
        "The API-spec routes: store, read and delete a spec; match, describe, diff, bind, export "
        "and sync it against a collection.",
        "`/specs`, `/specs/*`",
        "`routes/specs.cpp`, `spec_*.cpp`",
    ),
    "import": (
        None,
        "The import routes: fetch a document, parse it, import it and apply a reviewed plan.",
        "`/import`, `/import/*`",
        "`routes/import.cpp`",
    ),
    "export": (
        None,
        "The export routes: a Postman collection, a Postman environment and a run report.",
        "`/export/*`",
        "`routes/postman_export.cpp`, `run_export.cpp`",
    ),
    "environments": (
        "Environments and global variables",
        "The environment routes and the global-variables routes: list, create, update and delete.",
        "`/environments`, `/globals`",
        "`routes/environments.cpp`, `globals.cpp`",
    ),
    "changes": (
        None,
        "The change feed: how a client learns that another client changed saved data.",
        "`/changes`, `/changes/subscriptions`",
        "`routes/changes.cpp`",
    ),
    "cookies-and-certificates": (
        "Cookies, client certificates and transport diagnostics",
        "The cookie jar routes, the client-certificate routes and the connection probe that "
        "reports what a transfer to a host would negotiate.",
        "`/cookies`, `/client-certificates`, `/diagnostics/connection`",
        "`routes/cookies.cpp`, `client_certificates.cpp`, `diagnostics.cpp`",
    ),
    "file-access": (
        "Allowed folders and picked files",
        "The routes that grant the engine access to files: allowed folders and files the user "
        "picked.",
        "`/file-roots`, `/file-grants`",
        "`routes/file_roots.cpp`, `file_grants.cpp`",
    ),
    "inbox": (
        None,
        "The webhook inbox routes: start a local listener, read what it captured and stop it.",
        "`/inbox/*`",
        "`routes/inbox.cpp`",
    ),
    "mock-server": (
        None,
        "The mock-server routes: serve a collection's saved examples on a local port and read "
        "its routes and activity.",
        "`/mock/*`",
        "`routes/mock_server.cpp`",
    ),
    "authentication": (
        None,
        "The OAuth 2.0 routes: the token cache, the interactive authorization flow and the local "
        "mock issuer.",
        "`/oauth2/*`, `/mock-issuer/*`",
        "`routes/oauth.cpp`, `oauth_authorize.cpp`, `mock_issuer.cpp`",
    ),
    "compose": (
        None,
        "The compose route: what the engine would send for a request, without sending it - query "
        "encoding, path variables and the composed result.",
        "`/compose`",
        "`routes/compose.cpp`",
    ),
    "execute": (
        None,
        "POST /execute: the fields a send takes, every key of the answer, the timing convention "
        "and what a send that failed returns.",
        "`/execute`",
        "`routes/execution.cpp`",
    ),
    "load-runs": (
        None,
        "POST /runs: starting a run - the fields, streaming under load, data rows, thresholds, "
        "elements, the monitor block and the scenario block.",
        "`/runs` (start)",
        "`routes/execution.cpp`",
    ),
    "scenario-runs": (
        None,
        "A scenario run: a collection executed step by step, how its variables and outcomes "
        "are decided.",
        "`/runs` (collection runs)",
        "`routes/execution.cpp`",
    ),
    "scenario-load": (
        None,
        "A scenario load run: a collection driven under load, its stages, outcomes and metrics.",
        "`/runs` (scenario load)",
        "`routes/execution.cpp`",
    ),
    "metrics": (
        None,
        "What counts as an error, what the latency population is, and the metrics and monitor "
        "routes of a run.",
        "`/runs/:runId/metrics`, `/runs/:runId/monitor`",
        "`routes/metrics.cpp`",
    ),
    "live-metrics": (
        "Live metrics and events",
        "The live SSE stream of a running load test and the events route.",
        "`/runs/:runId/live`, `/runs/:runId/events`",
        "`routes/metrics.cpp`, `events.cpp`",
    ),
    "runs": (
        None,
        "The run-history routes: list runs, read one, stop it, read its report and samples, pin a "
        "baseline and delete runs.",
        "`/runs`, `/runs/:runId`, `.../stop`, `.../report`, `.../samples`, "
        "`.../results/:resultId`, `.../baseline`",
        "`routes/runs.cpp`",
    ),
    "collection-runs": (
        None,
        "Per-step verdicts in a collection run: the validation each step carries, and the "
        "sections a run report adds for each kind of run.",
        "`/runs/:runId/report` (sections)",
        "`routes/runs.cpp`",
    ),
    "scripting": (
        None,
        "The scripting completions and type-declaration routes the editor reads.",
        "`/scripting/*`",
        "`routes/scripting.cpp`, `script_types.cpp`",
    ),
}

# How many levels a titled page's headings move up. A page with a title of its
# own has its sections' top headings at the second level (a `##` group stays a
# `##`; a `###` route section becomes one).
TITLED_TOP_LEVEL = 2

LINE_BUDGET = 400

_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_HEADING_LINE = re.compile(r"^\s*#{1,6}\s")
_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])(\s+)\S")
_HTML = re.compile(r"^\s*<[A-Za-z/!]")
_LINK = re.compile(r"(\]\()([^)\s]+)((?:\s+\"[^\"]*\")?\))")
_CODE_SPAN = re.compile(r"(`+)(?:(?!\1).)+?\1")
_ABBREVIATION = re.compile(r"(?:^|[\s(])(?:e\.g|i\.e|vs|cf|approx)\.$", re.IGNORECASE)
_CLOSERS = ")*_\"'"
_STARTERS = re.compile(r"[A-Z`\[*(\"_]")
_BLOCK_START = re.compile(r"^(?:[-*+]\s|\d+[.)]\s|#|>|\||---|===)")
_URL = re.compile(r"[a-z][a-z0-9+.-]*:")


class SplitError(Exception):
    pass


def slug(heading: str) -> str:
    """GitHub's heading slug, as `pymdownx.slugs.slugify(case='lower')` makes it."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading.lstrip("# ").strip())
    text = text.replace("`", "").replace("*", "")
    text = re.sub(r"[^\w\- ]", "", text.lower())
    return text.replace(" ", "-")


def read_source(root: Path, rev: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "show", f"{rev}:{SOURCE_PATH}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def fenced(lines: list[str]) -> list[bool]:
    """Per line: whether it is inside fenced code or is a fence line."""
    flags: list[bool] = []
    inside = False
    for line in lines:
        if _FENCE.match(line):
            flags.append(True)
            inside = not inside
        else:
            flags.append(inside)
    return flags


def headings_of(lines: list[str]) -> list[tuple[int, int, str]]:
    """(line number, level, text) of every heading outside fenced code."""
    flags = fenced(lines)
    found = []
    for number, line in enumerate(lines):
        match = _HEADING.match(line)
        if match and not flags[number]:
            found.append((number, len(match.group(1)), match.group(2).strip()))
    return found


def sections(lines: list[str]) -> list[tuple[str, list[int]]]:
    """(page, source line numbers) per section, in source order."""
    flags = fenced(lines)
    starts: list[tuple[int, str]] = []
    cursor = 0
    for line, page in MARKERS:
        for number in range(cursor, len(lines)):
            if lines[number] == line and not flags[number]:
                starts.append((number, page))
                cursor = number + 1
                break
        else:
            raise SplitError(f"marker not found in the source: {line!r}")
    for (start, _), (line, _) in zip(starts[1:], MARKERS[1:]):
        if lines[start - 1].strip():
            raise SplitError(f"a section may not start mid-paragraph: {line!r}")
    ends = [number for number, _ in starts[1:]] + [len(lines)]
    return [(page, list(range(start, end))) for (start, page), end in zip(starts, ends)]


def page_text_lines(lines: list[str], layout) -> dict[str, list[str]]:
    body: dict[str, list[str]] = {page: [] for page in PAGES}
    for page, numbers in layout:
        body[page].extend(lines[number] for number in numbers)
    return body


def owners(page_lines: dict[str, list[str]]) -> dict[str, str]:
    """Anchor -> page, for every heading in the source; each anchor once."""
    owner: dict[str, str] = {}
    for page, lines in page_lines.items():
        for _, _, text in headings_of(lines):
            anchor = slug(text)
            if anchor in owner:
                raise SplitError(f"anchor #{anchor} names two headings")
            owner[anchor] = page
    return owner


def page_shift(page: str, lines: list[str]) -> tuple[bool, int]:
    """(promotes its first heading to the title, levels every heading moves up)."""
    title = PAGES[page][0]
    found = headings_of(lines)
    if page == "index":
        return False, 0
    if title is None:
        if not found or found[0][0] != 0:
            raise SplitError(f"{page}: a page without a title starts with a heading")
        if sum(1 for _, level, _ in found if level == found[0][1]) != 1:
            raise SplitError(f"{page}: only one heading sits at the top level to promote")
        return True, found[0][1] - 1
    top = min((level for _, level, _ in found), default=TITLED_TOP_LEVEL)
    return False, max(0, top - TITLED_TOP_LEVEL)


def aim_target(target: str, page: str, owner: dict[str, str]) -> str:
    if _URL.match(target):
        return target
    if target.startswith("#"):
        anchor = target[1:]
        home = owner.get(anchor)
        if home is None:
            raise SplitError(f"{page}: no heading for the link {target}")
        return target if home == page else f"{home}.md{target}"
    return f"../{target}"


def map_links(line: str, change) -> str:
    """Apply `change(target)` to each link target outside code spans."""
    out: list[str] = []
    position = 0
    for span in _CODE_SPAN.finditer(line):
        out.append(_LINK.sub(lambda m: f"{m.group(1)}{change(m.group(2))}{m.group(3)}", line[position:span.start()]))
        out.append(span.group(0))
        position = span.end()
    out.append(_LINK.sub(lambda m: f"{m.group(1)}{change(m.group(2))}{m.group(3)}", line[position:]))
    return "".join(out)


def transform(page: str, lines: list[str], owner: dict[str, str]) -> list[str]:
    """The page's lines with heading levels and link targets changed."""
    promote, shift = page_shift(page, lines)
    flags = fenced(lines)
    out: list[str] = []
    for number, line in enumerate(lines):
        if flags[number]:
            out.append(line)
            continue
        match = _HEADING.match(line)
        if match:
            level = len(match.group(1)) - shift
            if level < (1 if page == "index" or (promote and number == 0) else 2):
                raise SplitError(f"{page}: heading {line!r} would move above the second level")
            line = "#" * level + " " + match.group(2)
        out.append(map_links(line, lambda target: aim_target(target, page, owner)))
    return out


def page_titles(chunks: dict[str, list[str]]) -> dict[str, str]:
    """The title of each page: its own, or the heading it promotes."""
    return {
        name: PAGES[name][0] or headings_of(lines)[0][2]
        for name, lines in chunks.items()
    }


def pages_table(titles: dict[str, str]) -> list[str]:
    rows = ["| Page | Routes | Route files |", "|---|---|---|"]
    rows += [
        f"| [{titles[name]}]({name}.md) | {routes} | {files} |"
        for name, (_, _, routes, files) in PAGES.items()
        if name != "index"
    ]
    return ["## Pages", "", "Each page holds the routes of one group of route files.", "", *rows, ""]


def _front(name: str) -> str:
    return f"---\ndescription: >-\n  {PAGES[name][1]}\n---\n\n"


# ---- sentence-per-line reflow (whitespace only) -----------------------------

def end_of_sentence(text: str, at: int) -> bool:
    """Whether the whitespace at `at` follows the end of a sentence."""
    before = text[:at].rstrip(_CLOSERS)
    if not before or before[-1] not in ".?!" or _ABBREVIATION.search(before):
        return False
    after = text[at:].lstrip()
    return bool(after) and bool(_STARTERS.match(after)) and not _BLOCK_START.match(after)


def split_sentences(text: str) -> list[str]:
    """Break `text` after each sentence, never inside code, brackets or parentheses."""
    pieces: list[str] = []
    start = 0
    depth = 0
    in_code = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == "`":
            run = len(text[index:]) - len(text[index:].lstrip("`"))
            in_code = not in_code
            index += run
            continue
        if not in_code:
            if char in "[(":
                depth += 1
            elif char in "])":
                depth = max(0, depth - 1)
            elif char == " " and depth == 0 and end_of_sentence(text, index):
                pieces.append(text[start:index])
                start = index + 1
        index += 1
    pieces.append(text[start:])
    return [piece for piece in pieces if piece]


def break_points(text: str, nested: bool, inside_code: bool) -> dict[str, list[int]]:
    """Where a clause ends, by how strong a stop it is: index just past the separator.

    A stop is never inside a link's destination. Unless `nested`, it is never inside
    brackets or parentheses either, and unless `inside_code` never inside a code span.
    """
    points: dict[str, list[int]] = {";": [], ":": [], " -": [], ",": [], " ": []}
    barred = [match.span() for match in re.finditer(r"\]\([^)]*\)", text)]
    if not inside_code:
        barred += [match.span() for match in _CODE_SPAN.finditer(text)]
    depth = 0
    for index, char in enumerate(text):
        if any(start <= index < end for start, end in barred):
            continue
        if char in "[(":
            depth += 1
        elif char in "])":
            depth = max(0, depth - 1)
        elif (depth == 0 or nested) and index + 1 < len(text):
            following = text[index + 1] == " "
            if char in ";:," and following:
                points[char].append(index + 1)
            elif char == "-" and text[index - 1] == " " and following:
                points[" -"].append(index + 1)
            elif char == " " and text[index - 1] != " " and following is False:
                points[" "].append(index + 1)
    return points


# What a too-long sentence may be broken at, tried in order: a clause stop outside
# brackets, one inside them, any space outside code, any space at all.
_BREAK_PASSES = (
    (False, False, (";", ":", " -", ",")),
    (True, False, (";", ":", " -", ",")),
    (True, False, (" ",)),
    (True, True, (" ",)),
)


def fit(text: str) -> list[str]:
    """Break a sentence longer than the line budget at its strongest clause stop."""
    if len(text) <= LINE_BUDGET:
        return [text]
    for nested, inside_code, stops in _BREAK_PASSES:
        points = break_points(text, nested, inside_code)
        for stop in stops:
            usable = [
                at
                for at in points[stop]
                if at >= 40
                and len(text) - at >= 40
                and not _BLOCK_START.match(text[at:].lstrip())
            ]
            if usable:
                at = min(usable, key=lambda candidate: abs(candidate - len(text) / 2))
                return fit(text[:at].rstrip()) + fit(text[at:].lstrip())
    return [text]


def reflow_block(block: list[str]) -> list[str]:
    """One paragraph or list item, one sentence per line."""
    first = block[0]
    marker = _LIST.match(first)
    if marker:
        lead = len(marker.group(1)) + len(marker.group(2)) + len(marker.group(3))
    else:
        lead = len(first) - len(first.lstrip())
    indent = lead
    if len(block) > 1:
        indent = len(block[1]) - len(block[1].lstrip())
    head = first[:lead]
    text = " ".join([first[lead:].strip()] + [line.strip() for line in block[1:]])
    sentences = [piece for sentence in split_sentences(text) for piece in fit(sentence)]
    return [head + sentences[0]] + [" " * indent + sentence for sentence in sentences[1:]]


def reflow(lines: list[str]) -> list[str]:
    """One sentence per line in prose; every other block as it is."""
    out: list[str] = []
    block: list[str] = []
    in_fence = False

    def flush() -> None:
        if block:
            out.extend(reflow_block(block))
            block.clear()

    start = 0
    if lines and lines[0] == "---":
        start = lines.index("---", 1) + 1
        out.extend(lines[:start])
    for line in lines[start:]:
        if _FENCE.match(line):
            flush()
            in_fence = not in_fence
            out.append(line)
        elif in_fence or not line.strip():
            flush()
            out.append(line)
        elif _HEADING_LINE.match(line) or line.lstrip().startswith(("|", ">")) or _HTML.match(line):
            flush()
            out.append(line)
        elif _LIST.match(line):
            flush()
            block.append(line)
        else:
            block.append(line)
    flush()
    return out


# ---- build -------------------------------------------------------------------

def build(source: str) -> tuple[dict[str, str], dict]:
    """The pages (name -> text) and the facts `--verify` checks them against."""
    lines = source.split("\n")
    if lines[-1] == "":
        lines.pop()
    layout = sections(lines)
    chunks = page_text_lines(lines, layout)
    owner = owners(chunks)
    titles = page_titles(chunks)

    pages: dict[str, str] = {}
    for name, page_lines in chunks.items():
        body = transform(name, page_lines, owner)
        if name == "index":
            at = body.index(PAGES_TABLE_BEFORE)
            body[at:at] = pages_table(titles)
        else:
            front = _front(name).rstrip("\n").split("\n")
            promoted = PAGES[name][0] is None
            body = [*front, "", f"# {titles[name]}", *body[1:]] if promoted else [*front, "", f"# {titles[name]}", "", *body]
        while body and not body[-1].strip():
            body.pop()
        pages[name] = "\n".join(reflow(body)) + "\n"
    return pages, {"lines": lines, "layout": layout, "owner": owner, "titles": titles}


# ---- the links in every other markdown file ----------------------------------

def tracked_markdown(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "*.md"], check=True, capture_output=True, text=True
    ).stdout
    return [path for path in out.split("\n") if path and not path.startswith(OUT_DIR + "/")]


def aim_inbound(file: str, owner: dict[str, str], missing: list[str]):
    def change(target: str) -> str:
        if _URL.match(target) or target.startswith("#"):
            return target
        path, _, fragment = target.partition("#")
        if posixpath.normpath(posixpath.join(posixpath.dirname(file), path)) != SOURCE_PATH:
            return target
        home = "index" if not fragment else owner.get(fragment)
        if home is None:
            missing.append(f"{file}: no heading for #{fragment}")
            return target
        new = posixpath.relpath(f"{OUT_DIR}/{home}.md", posixpath.dirname(file) or ".")
        return new + (f"#{fragment}" if fragment else "")

    return change


_OLD_LABEL = re.compile(r"\[(`?)((?:docs/)?(?:engine/)?)api-reference\.md\1\]\(([^)\s]*/)?api-reference/([a-z-]+\.md)(#[^)\s]*)?\)")


def relabel(line: str) -> str:
    """A link labelled with the old file's name is labelled with the page it now opens."""
    return _OLD_LABEL.sub(
        lambda m: f"[{m.group(1)}{m.group(2)}api-reference/{m.group(4)}{m.group(1)}]({m.group(3) or ''}api-reference/{m.group(4)}{m.group(5) or ''})",
        line,
    )


def refit(line: str) -> list[str]:
    """A prose line over the budget broken at clause stops, its indent kept."""
    marker = _LIST.match(line)
    lead = len(marker.group(1)) + len(marker.group(2)) + len(marker.group(3)) if marker else len(line) - len(line.lstrip())
    pieces = fit(line[lead:])
    return [line[:lead] + pieces[0]] + [" " * lead + piece for piece in pieces[1:]]


def reshaped(old: str, new: str) -> list[str]:
    """`new`, which re-aims a link in `old`, as the lines it should be.

    A re-aimed link is longer than the one it replaces. A prose line that thereby
    first passes the line budget is broken at its clause stops, so the move adds
    no long line; a table row, heading or quote cannot be broken and stays, and a
    line that was already over the budget only grows by the link.
    """
    if len(old) > LINE_BUDGET or len(new) <= LINE_BUDGET:
        return [new]
    if new.lstrip().startswith(("|", ">", "#")):
        return [new]
    return refit(new)


def rewrite_inbound(root: Path, owner: dict[str, str], write: bool) -> tuple[list[str], list[str]]:
    """(files that change, links with no heading) for every markdown file but the pages."""
    changed: list[str] = []
    missing: list[str] = []
    for file in tracked_markdown(root):
        path = root / file
        if file == SOURCE_PATH or not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        flags = fenced(text.split("\n"))
        change = aim_inbound(file, owner, missing)
        out: list[str] = []
        for number, line in enumerate(text.split("\n")):
            out += [line] if flags[number] else reshaped(line, relabel(map_links(line, change)))
        new = "\n".join(out)
        if new != text:
            changed.append(file)
            if write:
                path.write_text(new, encoding="utf-8")
    return changed, missing


# ---- verify ------------------------------------------------------------------

def collapse(text: str) -> str:
    return " ".join(text.split())


def read_pages(root: Path) -> dict[str, str]:
    pages = {}
    for name in PAGES:
        path = root / OUT_DIR / f"{name}.md"
        if not path.exists():
            raise SplitError(f"missing page: {path}")
        pages[name] = path.read_text(encoding="utf-8")
    return pages


def undo_link(target: str, page: str, anchors: dict[str, set[str]]) -> str:
    """The link target as the source wrote it."""
    if _URL.match(target):
        return target
    if target.startswith("../"):
        return target[3:]
    match = re.fullmatch(r"([a-z0-9-]+)\.md(#.+)?", target)
    if match and match.group(1) in PAGES:
        fragment = match.group(2)
        if fragment is None or fragment[1:] not in anchors[match.group(1)]:
            raise SplitError(f"{page}: {target} names no heading on that page")
        return fragment
    if target.startswith("#"):
        if target[1:] not in anchors[page]:
            raise SplitError(f"{page}: {target} names no heading on this page")
        return target
    raise SplitError(f"{page}: link {target!r} is not one the split writes")


def undo_page(name: str, text: str, anchors: dict[str, set[str]], chunk: list[str], titles) -> str:
    """The page's text as the source's sections held it: title, levels, links undone."""
    body = text.rstrip("\n").split("\n")
    if name != "index":
        body = body[body.index("---", 1) + 1 :]
        while not body[0].strip():
            body.pop(0)
    else:
        table = pages_table(titles)[:-1]
        at = body.index(table[0])
        if body[at : at + len(table)] != table:
            raise SplitError("index: the table of pages is not the one the split writes")
        del body[at : at + len(table)]
    promote, shift = page_shift(name, chunk)
    if name != "index" and not promote:
        body = body[1:]
    flags = fenced(body)
    back: list[str] = []
    for number, line in enumerate(body):
        if not flags[number]:
            match = _HEADING.match(line)
            if match:
                line = "#" * (len(match.group(1)) + shift) + " " + match.group(2)
            line = map_links(line, lambda target: undo_link(target, name, anchors))
        back.append(line)
    return "\n".join(back)


def verify(root: Path, source: str) -> list[str]:
    findings: list[str] = []
    pages = read_pages(root)
    expected, facts = build(source)
    lines, layout, owner, titles = facts["lines"], facts["layout"], facts["owner"], facts["titles"]
    chunks = page_text_lines(lines, layout)

    if [number for _, numbers in layout for number in numbers] != sorted(
        number for _, numbers in layout for number in numbers
    ) or sum(len(numbers) for _, numbers in layout) != len(lines):
        findings.append("the sections do not cover the source exactly once, in order")

    found = {name: [slug(text) for _, _, text in headings_of(page.split("\n"))] for name, page in pages.items()}
    seen: dict[str, int] = {}
    for anchors in found.values():
        for anchor in anchors:
            seen[anchor] = seen.get(anchor, 0) + 1
    findings += [f"anchor #{anchor} appears {count} times" for anchor, count in seen.items() if count != 1]
    findings += [
        f"anchor #{anchor} is not on {home}.md" for anchor, home in owner.items() if anchor not in found[home]
    ]

    anchors = {name: set(values) for name, values in found.items()}
    for name, page in pages.items():
        try:
            got = collapse(undo_page(name, page, anchors, chunks[name], titles))
        except SplitError as error:
            findings.append(str(error))
            continue
        want = collapse("\n".join(chunks[name]))
        if got != want:
            at = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
            findings.append(f"{name}: text differs from the source's near {got[max(0, at - 40):at + 60]!r}")
        if page != expected[name]:
            findings.append(f"{name}: is not what a run would write")

    own_titles = sum(1 for name, entry in PAGES.items() if name != "index" and entry[0] is not None)
    old_count = len(headings_of(lines))
    new_count = sum(len(values) for values in found.values())
    if new_count != old_count + own_titles + 1:
        findings.append(f"{new_count} headings, not {old_count} + {own_titles} titles + the table's")
    return findings


class _Shape(HTMLParser):
    """The rendered page as tags and text: heading levels and link targets dropped."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        self.parts.append("<h>" if re.fullmatch(r"h[1-6]", tag) else f"<{tag}>")

    def handle_endtag(self, tag):
        self.parts.append("</h>" if re.fullmatch(r"h[1-6]", tag) else f"</{tag}>")

    def handle_data(self, data):
        self.parts.append(data)


def shape(markdown_text: str) -> str:
    import markdown
    import pymdownx.slugs

    html = markdown.Markdown(
        extensions=RENDER_EXTENSIONS,
        extension_configs={"toc": {"slugify": pymdownx.slugs.slugify(case="lower")}},
    ).convert(markdown_text)
    parser = _Shape()
    parser.feed(html)
    return " ".join("".join(parser.parts).split())


def render_findings(root: Path, source: str) -> list[str]:
    """Pages whose rendered HTML differs from their sections', as the site renders them.

    A line that opens with `#<digits>` (an issue number a hand wrap left at the
    start of a line) is a heading to Python-Markdown, so the old page held
    several by accident; the sections are joined there before they are rendered.
    """
    _, facts = build(source)
    chunks = page_text_lines(facts["lines"], facts["layout"])
    pages = read_pages(root)
    found = []
    for name, page in pages.items():
        body = page.rstrip("\n").split("\n")
        if name == "index":
            table = pages_table(facts["titles"])[:-1]
            at = body.index(table[0])
            del body[at : at + len(table)]
        else:
            body = body[body.index("---", 1) + 1 :]
            while not body[0].strip():
                body.pop(0)
            if not page_shift(name, chunks[name])[0]:
                body = body[1:]
        old = re.sub(r"(?<=[^\n])\n(?=#\d)", " ", "\n".join(chunks[name]))
        if shape(old) != shape("\n".join(body)):
            found.append(f"{name}: renders differently from its sections")
    return found


def check_nav(root: Path) -> list[str]:
    nav = (root / NAV_FILE).read_text(encoding="utf-8")
    return [f"{NAV_FILE} does not list {OUT_DIR}/{name}.md" for name in PAGES if f"{OUT_DIR[5:]}/{name}.md" not in nav]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--rev", default="origin/master")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--render", action="store_true")
    args = parser.parse_args()
    root = Path(args.root)

    try:
        source = read_source(root, args.rev)
        pages, facts = build(source)
        if args.render:
            findings = render_findings(root, source)
            print("\n".join(findings) if findings else "rendered: every page reads as its sections do")
            return 1 if findings else 0
        if args.verify:
            findings = verify(root, source)
            print("\n".join(findings) if findings else "verified: no text lost, none added")
            return 1 if findings else 0
        changed, missing = rewrite_inbound(root, facts["owner"], write=not args.check)
    except SplitError as error:
        print(f"split-api-reference: {error}", file=sys.stderr)
        return 1

    if missing:
        print("\n".join(missing))
        return 1
    stale = []
    for name, text in pages.items():
        path = root / OUT_DIR / f"{name}.md"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(str(path))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    if not args.check:
        (root / SOURCE_PATH).unlink(missing_ok=True)
    if args.check:
        stale += [f"{file} links the old page" for file in changed] + check_nav(root)
    if stale:
        print("out of date: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
