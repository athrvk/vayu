#!/usr/bin/env python3
"""
Splits docs/engine/mcp.md into the pages of docs/engine/mcp/ (#3848), and proves
the move lost nothing.

The source is the page as it stood at SOURCE_REV, read from git, so the script
reruns after the page is gone. It writes every page except `tools.md`, which
`pnpm docs:mcp-tools` generates from the tool registry.

What the move changes, and nothing else:

  - the page boundaries (MARKERS below say where each section goes);
  - one sentence per line in prose (a paragraph's line breaks are replaced by a
    break after each sentence; tables, fenced code, headings and quotes are
    copied as they are);
  - links, because a page moved down a directory: a relative target gains `../`
    and a `#fragment` that now lives on another page gains that page's name;
  - the lines FIXUPS rewrite, each of which names a position ("below", "above",
    "under Tools") the split made wrong;
  - the dropped lines (DROPPED): the front matter, the `## Tools` heading, the
    hand-kept tool table and its "Notes:" lead-in, which `tools.md` replaces.

`--check` rebuilds each page in memory and fails when a committed page differs,
and `--verify` proves the move: with whitespace collapsed, the pages' text is the
source's text less the dropped lines, with the same link rewrites applied and the
FIXUPS applied.

Usage: split-mcp-doc.py [--root DIR] [--check | --verify]
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

SOURCE_REV = "54ba46d51"
SOURCE_PATH = "docs/engine/mcp.md"
OUT_DIR = "docs/engine/mcp"

# Each marker starts a section; a section runs to the next marker. `prefix` is
# matched against the start of a source line, in source order. `page` is the
# destination, or None for a section that is dropped.
MARKERS = [
    ("---", "index"),
    ("## Transports", "transports"),
    ("## Tools", None),
    # Everything before the table: what every tool carries, and the categories.
    ("Every tool carries a `category`", "conventions"),
    ("| Tool                   | Category |", None),
    ("Notes:", None),
    ("- **`start_load_run`** requires confirmation", "load-and-specs"),
    ("- **A report read mid-run says so", "runs-and-reports"),
    ("- **`update_engine_config`** reads the config back", "saved-data"),
    ("- **`run_collection_smoke`** runs each saved request", "collection-runs-and-mocks"),
    ("### Reading a stored body", "runs-and-reports"),
    ("### Request composition", "request-composition"),
    ("### Variables", "saved-data"),
    ("### Data files", "saved-data"),
    ("### Error results", "conventions"),
    ("## Resources", "resources-and-prompts"),
    ("## Safety model", "safety"),
    ("### Secret values", "secrets"),
    ("### Safety config", "safety"),
    ("## Architecture", "internals"),
    ("## Configuration", "configuration"),
    ("## Design notes", "internals"),
]

# page -> (title, description). `index` keeps the source's own front matter and
# heading; it is here for the page order only.
PAGES = {
    "index": (None, None),
    "transports": (
        "MCP transports",
        "How the Vayu MCP server is reached - Streamable HTTP in the running app, "
        "the stdio CLI for Zed and CI - and what each transport supports.",
    ),
    "conventions": (
        "MCP tool conventions",
        "How every Vayu MCP tool is shaped - categories, annotations, schemas, "
        "argument names and result format - and how a failed call is reported.",
    ),
    "load-and-specs": (
        "MCP load runs and spec bindings",
        "Notes on the MCP tools that start load runs and bind, diff, sync and "
        "import API specs.",
    ),
    "runs-and-reports": (
        "MCP runs, reports and stored bodies",
        "Notes on the MCP tools that read runs, reports, traces and stored "
        "bodies, and the references an agent is given for what the user has open.",
    ),
    "saved-data": (
        "MCP writes to saved data",
        "Notes on the MCP tools that change saved data - engine config, "
        "collections, requests, examples, environments, variables, cookies and "
        "data files.",
    ),
    "collection-runs-and-mocks": (
        "MCP collection runs, OAuth and local services",
        "Notes on the MCP tools for collection smoke runs, OAuth 2.0 tokens, mock "
        "issuers and servers and webhook inboxes, and how a call is cancelled or "
        "times out.",
    ),
    "request-composition": (
        "MCP request composition",
        "How an MCP-sent request is composed by the engine: stored requests, "
        "scripts an agent supplies, scenarios and what each gate sees.",
    ),
    "resources-and-prompts": (
        "MCP resources and prompts",
        "The read-only resources and the prompts the Vayu MCP server offers an "
        "agent, including the script sandbox surface and the element catalogue.",
    ),
    "safety": (
        "MCP safety model",
        "The gates between an agent and the network and saved data: the "
        "allowlist, load caps, the write toggle and confirmation.",
    ),
    "secrets": (
        "MCP secret values",
        "Which stored values the MCP server withholds from an agent, how a "
        "withheld value is stated, and what reveal changes.",
    ),
    "configuration": (
        "MCP configuration",
        "The environment variables the stdio MCP CLI reads, and what a "
        "mistyped one does.",
    ),
    "internals": (
        "MCP internals",
        "How the MCP server is built - lifecycle, IPC and the registry - and the "
        "design decisions behind it, for contributors.",
    ),
}

# A fragment with no heading of its own: `tools` (the dropped `## Tools`) and
# `page:<name>`, a link to a whole page.
FRAGMENT_PAGE = {
    "tools": "collection-runs-and-mocks",
}

# (old, new, occurrences) edits to the source text, before links and wrapping;
# runs of whitespace in `old` match a line break too. A reference to a position
# ("below", "above") that the split moved onto another page becomes a link to
# that page. A link written here uses the source's own form, `(#heading)`, and
# is aimed like every other.
FIXUPS = [
    (
        "see `VAYU_ENGINE_URL` below)",
        "see `VAYU_ENGINE_URL` in [Configuration](#configuration))",
        1,
    ),
    ("Zed (stdio-only) uses the CLI below.", "Zed (stdio-only) uses [the CLI](#stdio-cli-zed--headless--ci).", 1),
    ("(see *Request composition* below)", "(see [Request composition](#request-composition))", 1),
    ("*Scenario runs* below)", "[*Scenario runs*](#request-composition))", 1),
    (
        "which is refused for MCP-started runs instead (below).",
        "which is refused for MCP-started runs instead "
        "([why](#pmsendrequest-is-refused-for-mcp-started-runs)).",
        1,
    ),
    ("see the write toggle below", "see [the write toggle](#safety-model)", 2),
    (
        "under the examples bullet above (#3422",
        "under [the examples bullet](#page:saved-data) (#3422",
        1,
    ),
    (
        "the 96 KB total trace budget above bounds",
        "the 96 KB total trace budget ([runs and reports](#page:runs-and-reports)) bounds",
        1,
    ),
    ("(issue #2949, below)", "(issue #2949, [Secret values](#secret-values))", 1),
    ("(*Error results*, below)", "([Error results](#error-results))", 1),
    (
        "(see *Scripts an agent supplies are refused*, above)",
        "(see [*Scripts an agent supplies are refused*](#request-composition))",
        2,
    ),
]

INDEX_ADDENDUM = """
## Where the rest is

- [Transports](transports.md): Streamable HTTP, the stdio CLI, and what is live on each.
- [Tools](tools.md): every tool, generated from the registry, with the count.
- [Tool conventions](conventions.md): categories, schemas, result format and error results.
- Notes on the tools by family: [load runs and specs](load-and-specs.md),
  [runs and reports](runs-and-reports.md), [writes to saved data](saved-data.md),
  [collection runs, OAuth and local services](collection-runs-and-mocks.md) and
  [request composition](request-composition.md).
- [Resources and prompts](resources-and-prompts.md).
- [Safety model](safety.md) and [secret values](secrets.md).
- [Configuration](configuration.md) of the stdio CLI.
- [Internals](internals.md): architecture and design notes, for contributors.
"""

LINE_BUDGET = 400

_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
_HEADING = re.compile(r"^\s*#{1,6}\s")
_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])(\s+)\S")
_HTML = re.compile(r"^\s*<[A-Za-z/!]")
_LINK = re.compile(r"(\]\()([^)\s]+)((?:\s+\"[^\"]*\")?\))")
_ABBREVIATION = re.compile(r"(?:^|[\s(])(?:e\.g|i\.e|vs|cf|approx)\.$", re.IGNORECASE)
_CLOSERS = ")*_\"'"
_STARTERS = re.compile(r"[A-Z`\[*(\"_]")
_BLOCK_START = re.compile(r"^(?:[-*+]\s|\d+[.)]\s|#|>|\||---|===)")


def read_source() -> str:
    return subprocess.run(
        ["git", "show", f"{SOURCE_REV}:{SOURCE_PATH}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def slug(heading: str) -> str:
    """GitHub's heading slug, as `pymdownx.slugs.slugify(case='lower')` makes it."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading.lstrip("# ").strip())
    text = text.replace("`", "").replace("*", "")
    text = re.sub(r"[^\w\- ]", "", text.lower())
    return text.replace(" ", "-")


def sections(lines: list[str]) -> list[tuple[str | None, list[int]]]:
    """(page, source line numbers) per section, in source order."""
    starts: list[tuple[int, str | None]] = []
    cursor = 0
    for prefix, page in MARKERS:
        for number in range(cursor, len(lines)):
            if lines[number].startswith(prefix):
                starts.append((number, page))
                cursor = number + 1
                break
        else:
            sys.exit(f"marker not found in the source: {prefix!r}")
    ends = [number for number, _ in starts[1:]] + [len(lines)]
    return [(page, list(range(start, end))) for (start, page), end in zip(starts, ends)]


def page_of_fragments(lines: list[str], layout) -> dict[str, str]:
    """Fragment -> page for every heading in the source (fences skipped)."""
    owner: dict[int, str | None] = {}
    for page, numbers in layout:
        for number in numbers:
            owner[number] = page
    fragments: dict[str, str] = {}
    in_fence = False
    for number, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
        if in_fence or not _HEADING.match(line) or owner.get(number) is None:
            continue
        fragments.setdefault(slug(line), owner[number])
    return fragments


def target_file(page: str) -> str:
    return f"{page}.md"


def rewrite_links(text: str, page: str, fragments: dict[str, str]) -> str:
    """Re-aim each markdown link at where its target is, from `page`'s directory."""
    out: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
        if in_fence:
            out.append(line)
            continue

        def aim(match: re.Match) -> str:
            head, target, tail = match.groups()
            if re.match(r"[a-z][a-z0-9+.-]*:", target):
                return match.group(0)
            if target.startswith("#"):
                fragment = target[1:]
                if fragment.startswith("page:"):
                    owner, kept = fragment[len("page:"):], ""
                elif fragment in FRAGMENT_PAGE:
                    owner, kept = FRAGMENT_PAGE[fragment], ""
                else:
                    owner, kept = fragments.get(fragment), target
                if owner is None:
                    sys.exit(f"{page}: no heading for the link {target}")
                if owner == page and not kept == "":
                    return match.group(0)
                return f"{head}{target_file(owner)}{kept}{tail}"
            return f"{head}../{target}{tail}"

        out.append(_LINK.sub(aim, line))
    return "\n".join(out)


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


def break_points(text: str) -> dict[str, list[int]]:
    """Where a clause ends, by how strong a stop it is: index just past the separator."""
    points: dict[str, list[int]] = {";": [], ":": [], " -": [], ",": []}
    depth = 0
    in_code = False
    for index, char in enumerate(text):
        if char == "`":
            in_code = not in_code
        if in_code:
            continue
        if char in "[(":
            depth += 1
        elif char in "])":
            depth = max(0, depth - 1)
        elif depth == 0 and index + 1 < len(text):
            following = text[index + 1] == " "
            if char in ";:," and following:
                points[char].append(index + 1)
            elif char == "-" and text[index - 1] == " " and following:
                points[" -"].append(index + 1)
    return points


def fit(text: str) -> list[str]:
    """Break a sentence longer than the line budget at its strongest clause stop."""
    if len(text) <= LINE_BUDGET:
        return [text]
    points = break_points(text)
    for stop in (";", ":", " -", ","):
        usable = [
            at
            for at in points[stop]
            if at >= 40
            and len(text) - at >= 40
            and not _BLOCK_START.match(text[at:].lstrip())
        ]
        if usable:
            at = min(usable, key=lambda candidate: abs(candidate - len(text) / 2))
            return fit(text[:at]) + fit(text[at:].lstrip())
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


def reflow(text: str) -> str:
    """One sentence per line in prose; every other block as it is."""
    out: list[str] = []
    block: list[str] = []
    in_fence = False

    def flush() -> None:
        if block:
            out.extend(reflow_block(block))
            block.clear()

    lines = text.split("\n")
    if lines[0] == "---":
        close = lines.index("---", 1) + 1
        out.extend(lines[:close])
        lines = lines[close:]
    for line in lines:
        if _FENCE.match(line):
            flush()
            in_fence = not in_fence
            out.append(line)
        elif in_fence or not line.strip():
            flush()
            out.append(line)
        elif _HEADING.match(line) or line.lstrip().startswith(("|", ">")) or _HTML.match(line):
            flush()
            out.append(line)
        elif _LIST.match(line):
            flush()
            block.append(line)
        else:
            block.append(line)
    flush()
    return "\n".join(out)


def front_matter(page: str) -> str:
    title, description = PAGES[page]
    return f"---\ndescription: >-\n  {description}\n---\n\n# {title}\n\n"


def fixup(old: str, new: str, text: str) -> str:
    pattern = r"\s+".join(re.escape(word) for word in old.split())
    return re.sub(pattern, lambda _: new, text)


def build() -> tuple[dict[str, str], dict]:
    """The pages (name -> text) and the facts `--verify` checks them against."""
    lines = read_source().split("\n")
    layout = sections(lines)
    fragments = page_of_fragments(lines, layout)

    body: dict[str, list[str]] = {page: [] for page in PAGES}
    dropped: list[str] = []
    for page, numbers in layout:
        chunk = "\n".join(lines[number] for number in numbers)
        if page is None:
            dropped.append(chunk)
        else:
            body[page].append(chunk)

    whole = "\n".join(lines)
    for old, _, count in FIXUPS:
        found = len(re.findall(r"\s+".join(re.escape(word) for word in old.split()), whole))
        if found != count:
            sys.exit(f"fix-up {old!r} matches {found} times, expected {count}")

    pages: dict[str, str] = {}
    expected: dict[str, str] = {}
    for page, chunks in body.items():
        text = "\n".join(chunk.rstrip("\n") + "\n" for chunk in chunks)
        for old, new, _ in FIXUPS:
            text = fixup(old, new, text)
        aimed = rewrite_links(text, page, fragments)
        if page == "index":
            aimed = aimed.rstrip("\n") + "\n" + INDEX_ADDENDUM
        expected[page] = aimed
        pages[page] = (front_matter(page) if page != "index" else "") + reflow(aimed).rstrip("\n") + "\n"
    return pages, {"expected": expected, "dropped": dropped, "lines": lines}


def collapse(text: str) -> str:
    return " ".join(text.split())


def verify(pages: dict[str, str], facts: dict) -> list[str]:
    """Findings: a page whose text differs from the source's, or a lost line."""
    findings: list[str] = []
    for page, text in pages.items():
        body = text
        if page != "index":
            body = text.split("\n\n# ", 1)[1].split("\n", 1)[1]
        if collapse(body) != collapse(facts["expected"][page]):
            findings.append(f"{page}: text differs from the source's after collapsing whitespace")
    kept = collapse(" ".join(facts["expected"].values()))
    for chunk in facts["dropped"]:
        for line in chunk.split("\n"):
            if len(line.strip()) > 30 and collapse(line) in kept:
                findings.append(f"a dropped line is still present: {line[:60]!r}")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    root = Path(args.root)

    pages, facts = build()
    if args.verify:
        findings = verify(pages, facts)
        print("\n".join(findings) if findings else "verified: no text lost, none added")
        return 1 if findings else 0

    stale = []
    for page, text in pages.items():
        path = root / OUT_DIR / target_file(page)
        if args.check:
            if not path.exists() or path.read_text() != text:
                stale.append(str(path))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if stale:
        print("out of date: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
