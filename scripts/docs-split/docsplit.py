"""
The machinery behind the page splits in this directory: it cuts one documentation
page into the pages of a directory of the same name, re-aims every link to it, and
proves the move lost nothing. Each `split-*.py` script holds only what is particular
to its page: where the sections go (`Split.markers`) and the new text (titles,
descriptions, the index's table of pages).

The source is the page as it stands at --rev (default origin/master), read from git,
so a script reruns after the page is gone. Rerun it against the tip just before
merging: edits made to the old page since the last run are carried, not lost.

What a move changes, and nothing else:

  - the page boundaries (the markers say where each section goes);
  - a page title and front matter, and the index's table of pages (new text);
  - heading levels: a page promotes its first heading to the title where it has
    one section, and every heading on the page moves up by the same amount;
  - one sentence per line in prose (a paragraph's line breaks are replaced by a
    break after each sentence, except a line break written as two trailing
    spaces, which stays; tables, fenced code, headings and quotes are copied as
    they are);
  - link targets: a relative target gains `../` because a page moved down a
    directory, a `#fragment` that now lives on another page gains that page's
    name, and a link in any other page to the old page is aimed at the new one;
  - the `---` rules and blank lines a page would end on, which set a section apart
    from the one after it and have nothing to do at the end of a page.

No prose is edited. An anchor never changes, so a fragment that named a heading
still names it.

Modes of every script:

  (none)    write the pages and re-aim the links in the other markdown files
  --check   fail when a committed page, or a link to the old page, differs from
            what a run would write
  --verify  prove the committed pages hold the source's text: undo the title, the
            heading levels and the link targets, collapse whitespace, and compare
            with the source's sections; every old anchor must appear exactly once
  --render  render each page and its sections with the site's Markdown and compare
            the tags and text (needs requirements-docs.txt installed)

To rerun one just before merging, with the old page's conflict resolved by deleting
it: run the script with `--rev origin/master`, then `--verify`, `--render` and
`mkdocs build --strict -f .github/mkdocs.yml`.
"""

import argparse
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

NAV_FILE = ".github/mkdocs.yml"

# The extensions the site renders pages with (.github/mkdocs.yml), less the ones
# that only restyle: what `--render` needs to read the same structure.
RENDER_EXTENSIONS = [
    "admonition", "attr_list", "def_list", "footnotes", "md_in_html", "tables", "toc",
    "pymdownx.details", "pymdownx.superfences", "pymdownx.inlinehilite", "pymdownx.tabbed",
]

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


def fit(text: str, budget: int = LINE_BUDGET) -> list[str]:
    """Break a sentence longer than `budget` at its strongest clause stop."""
    if len(text) <= budget:
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
                return fit(text[:at].rstrip(), budget) + fit(text[at:].lstrip(), budget)
    return [text]


def reflow_block(block: list[str], hard_break: bool = False) -> list[str]:
    """One paragraph or list item, one sentence per line.

    With `hard_break` the last line keeps the two trailing spaces that make a
    Markdown line break, which joining the lines would otherwise drop.
    """
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
    budget = LINE_BUDGET - max(lead, indent)
    sentences = [piece for sentence in split_sentences(text) for piece in fit(sentence, budget)]
    out = [head + sentences[0]] + [" " * indent + sentence for sentence in sentences[1:]]
    if hard_break:
        out[-1] += "  "
    return out


def is_prose(line: str) -> bool:
    """Whether a line continues a paragraph rather than starting another block."""
    return bool(line.strip()) and not (
        _FENCE.match(line)
        or _HEADING_LINE.match(line)
        or _LIST.match(line)
        or line.lstrip().startswith(("|", ">"))
        or _HTML.match(line)
    )


def reflow(lines: list[str]) -> list[str]:
    """One sentence per line in prose; every other block as it is."""
    out: list[str] = []
    block: list[str] = []
    in_fence = False

    def flush(hard_break: bool = False) -> None:
        if block:
            out.extend(reflow_block(block, hard_break))
            block.clear()

    start = 0
    if lines and lines[0] == "---":
        start = lines.index("---", 1) + 1
        out.extend(lines[:start])
    for number in range(start, len(lines)):
        line = lines[number]
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
        # A line ending in two spaces is a line break inside the paragraph: the
        # block ends there so the break survives the join.
        if block and line.endswith("  ") and number + 1 < len(lines) and is_prose(lines[number + 1]):
            flush(hard_break=True)
    flush()
    return out


def collapse(text: str) -> str:
    return " ".join(text.split())


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


# ---- the split ---------------------------------------------------------------

@dataclass(frozen=True)
class Page:
    """One page of a split. A `title` of None promotes the page's one top heading."""

    title: str | None
    description: str | None
    cells: tuple[str, ...] = ()


@dataclass(frozen=True)
class Split:
    """What differs between one page's split and another's."""

    source: str  # the page, as `docs/<dir>/<name>.md`; its pages go in `docs/<dir>/<name>/`
    markers: list[tuple[str, str]]  # (source line, page): see `sections`
    pages: dict[str, Page]  # in nav order, `index` first
    table_columns: tuple[str, ...]  # the index table's columns after the page's link
    table_intro: str  # the sentence that opens the index's table of pages
    table_before: str  # the index heading the table goes in front of
    prog: str  # the script's name, for messages
    label_prefix: str = r"(?:docs/)?"  # what a link label may carry before the file name

    @property
    def name(self) -> str:
        return posixpath.basename(self.source)[: -len(".md")]

    @property
    def out_dir(self) -> str:
        return self.source[: -len(".md")]

    @property
    def nav_dir(self) -> str:
        return self.out_dir[len("docs/") :]


def read_source(cfg: Split, root: Path, rev: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "show", f"{rev}:{cfg.source}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def sections(cfg: Split, lines: list[str]) -> list[tuple[str, list[int]]]:
    """(page, source line numbers) per section, in source order.

    Each marker starts a section, which runs to the next marker. A marker is
    matched against a whole source line outside fenced code, in source order. A
    page may own several sections; they keep their source order on the page.
    """
    flags = fenced(lines)
    starts: list[tuple[int, str]] = []
    cursor = 0
    for line, page in cfg.markers:
        for number in range(cursor, len(lines)):
            if lines[number] == line and not flags[number]:
                starts.append((number, page))
                cursor = number + 1
                break
        else:
            raise SplitError(f"marker not found in the source: {line!r}")
    for (start, _), (line, _) in zip(starts[1:], cfg.markers[1:]):
        if lines[start - 1].strip():
            raise SplitError(f"a section may not start mid-paragraph: {line!r}")
    ends = [number for number, _ in starts[1:]] + [len(lines)]
    return [(page, list(range(start, end))) for (start, page), end in zip(starts, ends)]


def page_text_lines(cfg: Split, lines: list[str], layout) -> dict[str, list[str]]:
    body: dict[str, list[str]] = {page: [] for page in cfg.pages}
    for page, numbers in layout:
        body[page].extend(lines[number] for number in numbers)
    return body


def owners(page_lines: dict[str, list[str]]) -> dict[str, str | None]:
    """Anchor -> page, for every heading in the source.

    Two headings with one text (`### Features` under two clients) share a slug: the
    site numbers the second `-1`. Split onto two pages each is the first of its
    page, so the anchor means two places and a link to it cannot be aimed: it maps
    to None, and a link that uses it stops the split.
    """
    owner: dict[str, str | None] = {}
    for page, lines in page_lines.items():
        for _, _, text in headings_of(lines):
            anchor = slug(text)
            owner[anchor] = None if anchor in owner else page
    return owner


def page_shift(cfg: Split, page: str, lines: list[str]) -> tuple[bool, int]:
    """(promotes its first heading to the title, levels every heading moves up)."""
    title = cfg.pages[page].title
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


def home_of(owner: dict[str, str | None], anchor: str, where: str) -> str:
    """The page an anchor lives on; a link to a missing or a doubled one stops the split."""
    if anchor not in owner:
        raise SplitError(f"{where}: no heading for the link #{anchor}")
    if owner[anchor] is None:
        raise SplitError(f"{where}: #{anchor} names two headings, so a link to it cannot be aimed")
    return owner[anchor]


def aim_target(target: str, page: str, owner: dict[str, str | None]) -> str:
    if _URL.match(target):
        return target
    if target.startswith("#"):
        home = home_of(owner, target[1:], page)
        return target if home == page else f"{home}.md{target}"
    return f"../{target}"


def transform(cfg: Split, page: str, lines: list[str], owner: dict[str, str | None]) -> list[str]:
    """The page's lines with heading levels and link targets changed."""
    promote, shift = page_shift(cfg, page, lines)
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


def page_titles(cfg: Split, chunks: dict[str, list[str]]) -> dict[str, str]:
    """The title of each page: its own, or the heading it promotes."""
    return {name: cfg.pages[name].title or headings_of(lines)[0][2] for name, lines in chunks.items()}


def pages_table(cfg: Split, titles: dict[str, str]) -> list[str]:
    header = ("Page", *cfg.table_columns)
    rows = [f"| {' | '.join(header)} |", "|" + "---|" * len(header)]
    rows += [
        f"| [{titles[name]}]({name}.md) | {' | '.join(page.cells)} |"
        for name, page in cfg.pages.items()
        if name != "index"
    ]
    return ["## Pages", "", cfg.table_intro, "", *rows, ""]


def front_matter(cfg: Split, name: str) -> list[str]:
    return ["---", "description: >-", f"  {cfg.pages[name].description}", "---"]


def trim_tail(lines: list[str]) -> list[str]:
    """The lines without the blank lines and `---` rules a page would end on.

    A section ends on the rule that set it apart from the next one; a page that
    ends there has nothing to be set apart from.
    """
    end = len(lines)
    while end and lines[end - 1].strip() in ("", "---"):
        end -= 1
    return lines[:end]


def build(cfg: Split, source: str) -> tuple[dict[str, str], dict]:
    """The pages (name -> text) and the facts `--verify` checks them against."""
    lines = source.split("\n")
    if lines[-1] == "":
        lines.pop()
    layout = sections(cfg, lines)
    chunks = page_text_lines(cfg, lines, layout)
    owner = owners(chunks)
    titles = page_titles(cfg, chunks)

    pages: dict[str, str] = {}
    for name, page_lines in chunks.items():
        body = transform(cfg, name, page_lines, owner)
        if name == "index":
            at = body.index(cfg.table_before)
            body[at:at] = pages_table(cfg, titles)
        else:
            promoted = cfg.pages[name].title is None
            head = [*front_matter(cfg, name), "", f"# {titles[name]}"]
            body = [*head, *body[1:]] if promoted else [*head, "", *body]
        pages[name] = "\n".join(reflow(trim_tail(body))) + "\n"
    return pages, {"lines": lines, "layout": layout, "owner": owner, "titles": titles}


# ---- the links in every other markdown file ----------------------------------

def tracked_markdown(cfg: Split, root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "*.md"], check=True, capture_output=True, text=True
    ).stdout
    return [path for path in out.split("\n") if path and not path.startswith(cfg.out_dir + "/")]


def aim_inbound(cfg: Split, file: str, owner: dict[str, str | None], missing: list[str]):
    def change(target: str) -> str:
        if _URL.match(target) or target.startswith("#"):
            return target
        path, _, fragment = target.partition("#")
        if posixpath.normpath(posixpath.join(posixpath.dirname(file), path)) != cfg.source:
            return target
        try:
            home = "index" if not fragment else home_of(owner, fragment, file)
        except SplitError as error:
            missing.append(str(error))
            return target
        new = posixpath.relpath(f"{cfg.out_dir}/{home}.md", posixpath.dirname(file) or ".")
        return new + (f"#{fragment}" if fragment else "")

    return change


def relabel(cfg: Split, line: str) -> str:
    """A link labelled with the old file's name is labelled with the page it now opens."""
    old = re.compile(
        rf"\[(`?)({cfg.label_prefix}){re.escape(cfg.name)}\.md\1\]"
        rf"\(([^)\s]*/)?{re.escape(cfg.name)}/([a-z0-9-]+\.md)(#[^)\s]*)?\)"
    )
    return old.sub(
        lambda m: f"[{m.group(1)}{m.group(2)}{cfg.name}/{m.group(4)}{m.group(1)}]"
        f"({m.group(3) or ''}{cfg.name}/{m.group(4)}{m.group(5) or ''})",
        line,
    )


def refit(line: str) -> list[str]:
    """A prose line over the budget broken at clause stops, its indent kept."""
    marker = _LIST.match(line)
    lead = len(marker.group(1)) + len(marker.group(2)) + len(marker.group(3)) if marker else len(line) - len(line.lstrip())
    pieces = fit(line[lead:], LINE_BUDGET - lead)
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


def rewrite_inbound(cfg: Split, root: Path, owner: dict[str, str | None], write: bool) -> tuple[list[str], list[str]]:
    """(files that change, links with no heading) for every markdown file but the pages."""
    changed: list[str] = []
    missing: list[str] = []
    for file in tracked_markdown(cfg, root):
        path = root / file
        if file == cfg.source or not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        flags = fenced(text.split("\n"))
        change = aim_inbound(cfg, file, owner, missing)
        out: list[str] = []
        for number, line in enumerate(text.split("\n")):
            out += [line] if flags[number] else reshaped(line, relabel(cfg, map_links(line, change)))
        new = "\n".join(out)
        if new != text:
            changed.append(file)
            if write:
                path.write_text(new, encoding="utf-8")
    return changed, missing


# ---- verify ------------------------------------------------------------------

def read_pages(cfg: Split, root: Path) -> dict[str, str]:
    pages = {}
    for name in cfg.pages:
        path = root / cfg.out_dir / f"{name}.md"
        if not path.exists():
            raise SplitError(f"missing page: {path}")
        pages[name] = path.read_text(encoding="utf-8")
    return pages


def undo_link(cfg: Split, target: str, page: str, anchors: dict[str, set[str]]) -> str:
    """The link target as the source wrote it."""
    if _URL.match(target):
        return target
    if target.startswith("../"):
        return target[3:]
    match = re.fullmatch(r"([a-z0-9-]+)\.md(#.+)?", target)
    if match and match.group(1) in cfg.pages:
        fragment = match.group(2)
        if fragment is None or fragment[1:] not in anchors[match.group(1)]:
            raise SplitError(f"{page}: {target} names no heading on that page")
        return fragment
    if target.startswith("#"):
        if target[1:] not in anchors[page]:
            raise SplitError(f"{page}: {target} names no heading on this page")
        return target
    raise SplitError(f"{page}: link {target!r} is not one the split writes")


def page_body(cfg: Split, name: str, text: str, titles: dict[str, str]) -> list[str]:
    """The page's lines without its front matter, or without the index's table of pages."""
    body = text.rstrip("\n").split("\n")
    if name != "index":
        body = body[body.index("---", 1) + 1 :]
        while not body[0].strip():
            body.pop(0)
        return body
    table = pages_table(cfg, titles)[:-1]
    at = body.index(table[0])
    if body[at : at + len(table)] != table:
        raise SplitError("index: the table of pages is not the one the split writes")
    del body[at : at + len(table)]
    return body


def undo_page(cfg: Split, name: str, text: str, anchors: dict[str, set[str]], chunk: list[str], titles) -> str:
    """The page's text as the source's sections held it: title, levels, links undone."""
    body = page_body(cfg, name, text, titles)
    promote, shift = page_shift(cfg, name, chunk)
    if name != "index" and not promote:
        body = body[1:]
    flags = fenced(body)
    back: list[str] = []
    for number, line in enumerate(body):
        if not flags[number]:
            match = _HEADING.match(line)
            if match:
                line = "#" * (len(match.group(1)) + shift) + " " + match.group(2)
            line = map_links(line, lambda target: undo_link(cfg, target, name, anchors))
        back.append(line)
    return "\n".join(back)


def verify(cfg: Split, root: Path, source: str) -> list[str]:
    findings: list[str] = []
    pages = read_pages(cfg, root)
    expected, facts = build(cfg, source)
    lines, layout, owner, titles = facts["lines"], facts["layout"], facts["owner"], facts["titles"]
    chunks = page_text_lines(cfg, lines, layout)

    if [number for _, numbers in layout for number in numbers] != sorted(
        number for _, numbers in layout for number in numbers
    ) or sum(len(numbers) for _, numbers in layout) != len(lines):
        findings.append("the sections do not cover the source exactly once, in order")

    found = {name: [slug(text) for _, _, text in headings_of(page.split("\n"))] for name, page in pages.items()}
    seen: dict[str, int] = {}
    for anchors in found.values():
        for anchor in anchors:
            seen[anchor] = seen.get(anchor, 0) + 1
    was: dict[str, int] = {}
    for _, _, text in headings_of(lines):
        was[slug(text)] = was.get(slug(text), 0) + 1
    findings += [
        f"anchor #{anchor} appears {seen.get(anchor, 0)} times, not {count}"
        for anchor, count in was.items()
        if seen.get(anchor, 0) != count
    ]
    findings += [
        f"anchor #{anchor} is not on {home}.md"
        for anchor, home in owner.items()
        if home is not None and anchor not in found[home]
    ]

    anchors = {name: set(values) for name, values in found.items()}
    for name, page in pages.items():
        try:
            got = collapse(undo_page(cfg, name, page, anchors, chunks[name], titles))
        except SplitError as error:
            findings.append(str(error))
            continue
        want = collapse("\n".join(trim_tail(chunks[name])))
        if got != want:
            at = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
            findings.append(f"{name}: text differs from the source's near {got[max(0, at - 40):at + 60]!r}")
        if page != expected[name]:
            findings.append(f"{name}: is not what a run would write")

    own_titles = sum(1 for name, page in cfg.pages.items() if name != "index" and page.title is not None)
    old_count = len(headings_of(lines))
    new_count = sum(len(values) for values in found.values())
    if new_count != old_count + own_titles + 1:
        findings.append(f"{new_count} headings, not {old_count} + {own_titles} titles + the table's")
    return findings


def render_findings(cfg: Split, root: Path, source: str) -> list[str]:
    """Pages whose rendered HTML differs from their sections', as the site renders them.

    A line that opens with `#<digits>` (an issue number a hand wrap left at the
    start of a line) is a heading to Python-Markdown, so a hand-wrapped page can
    hold several by accident; the sections are joined there before they are
    rendered.
    """
    _, facts = build(cfg, source)
    chunks = page_text_lines(cfg, facts["lines"], facts["layout"])
    found = []
    for name, page in read_pages(cfg, root).items():
        body = page_body(cfg, name, page, facts["titles"])
        if name != "index" and not page_shift(cfg, name, chunks[name])[0]:
            body = body[1:]
        old = re.sub(r"(?<=[^\n])\n(?=#\d)", " ", "\n".join(trim_tail(chunks[name])))
        if shape(old) != shape("\n".join(body)):
            found.append(f"{name}: renders differently from its sections")
    return found


def check_nav(cfg: Split, root: Path) -> list[str]:
    nav = (root / NAV_FILE).read_text(encoding="utf-8")
    return [
        f"{NAV_FILE} does not list {cfg.out_dir}/{name}.md"
        for name in cfg.pages
        if f"{cfg.nav_dir}/{name}.md" not in nav
    ]


def sizes(cfg: Split, pages: dict[str, str]) -> list[str]:
    return [f"{len(text.splitlines()):5d} {cfg.out_dir}/{name}.md" for name, text in pages.items()]


def main(cfg: Split) -> int:
    parser = argparse.ArgumentParser(description=f"Splits {cfg.source} into {cfg.out_dir}/.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--rev", default="origin/master", help="where to read the old page from")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="fail when a committed page differs from a run")
    mode.add_argument("--verify", action="store_true", help="prove the pages hold the source's text")
    mode.add_argument("--render", action="store_true", help="compare the rendered HTML (needs mkdocs's Markdown)")
    args = parser.parse_args()
    root = Path(args.root)

    try:
        source = read_source(cfg, root, args.rev)
        pages, facts = build(cfg, source)
        if args.render:
            findings = render_findings(cfg, root, source)
            print("\n".join(findings) if findings else "rendered: every page reads as its sections do")
            return 1 if findings else 0
        if args.verify:
            findings = verify(cfg, root, source)
            print("\n".join(findings) if findings else "verified: no text lost, none added")
            return 1 if findings else 0
        changed, missing = rewrite_inbound(cfg, root, facts["owner"], write=not args.check)
    except SplitError as error:
        print(f"{cfg.prog}: {error}", file=sys.stderr)
        return 1

    if missing:
        print("\n".join(missing))
        return 1
    stale = []
    for name, text in pages.items():
        path = root / cfg.out_dir / f"{name}.md"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(str(path))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    if not args.check:
        (root / cfg.source).unlink(missing_ok=True)
        print("\n".join(sizes(cfg, pages)))
    if args.check:
        stale += [f"{file} links the old page" for file in changed] + check_nav(cfg, root)
    if stale:
        print("out of date: " + ", ".join(stale))
        return 1
    return 0
