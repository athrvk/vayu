#!/usr/bin/env python3
"""Stage 2: split the reshaped COMPONENTS.md into one page per module (#3847).

Run from the repository root, with this directory on PYTHONPATH:

    git show 173f83152:docs/app/COMPONENTS.md > /tmp/stage1.md
    PYTHONPATH=scripts/split-components-md python3 scripts/split-components-md/split.py split  /tmp/stage1.md /tmp/pages
    PYTHONPATH=scripts/split-components-md python3 scripts/split-components-md/split.py verify /tmp/stage1.md /tmp/pages

`verify` rebuilds the page from the pages and fails unless it is byte-identical,
once the generated front matter, titles, heading levels and link destinations are
undone (and each link destination is checked against its old target). It also
fails unless every heading anchor of the old page appears exactly once.
"""
import re
import sys
from pathlib import Path

from mdlib import scan, slug
from pages import PAGES

DIRNAME = "COMPONENTS"
SINGLE = lambda hs: len(hs) == 1  # a lone section is promoted: its H2 becomes the page's H1
PAGES_MARKER = "## Pages"
COVERS = {"app-shell": "The app shell: `App`, error handling, the title bar, tab strip, shell, drawer, context bar and rail, activity rail, bottom panel, dock and context menus"}

_LINK = re.compile(r"\]\(([^)\s]+)((?:\s+\"[^\"]*\")?)\)")
_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")


def front(description):
    return f"---\ndescription: >-\n  {description}\n---\n\n"


def sections(lines):
    """Index chunk and one chunk per H2, each chunk stripped of trailing blank lines."""
    starts = [(i, d[1]) for i, k, d in scan(lines) if k == "heading" and d[0] == 2]
    first_page = PAGES[0][3][0]
    starts_pages = [s for s in starts if s[0] >= next(i for i, n in starts if n == first_page)]
    first = starts_pages[0][0]
    starts = starts_pages
    bounds = [i for i, _ in starts] + [len(lines)]
    chunks = {}
    for (i, name), end in zip(starts, bounds[1:]):
        chunks[name] = lines[i:end]
    return lines[: first], chunks


def trim(chunk):
    chunk = list(chunk)
    while chunk and chunk[-1] == "":
        chunk.pop()
    return chunk


def map_links(chunk, fn):
    """Apply fn to each link destination outside fences and code spans."""
    out = []
    fence = None
    from mdlib import dl

    for line in chunk:
        opener = dl._FENCE.match(line)
        if opener:
            marks = opener.group(1)
            if fence is None:
                fence = marks
            elif marks[0] == fence[0] and len(marks) >= len(fence):
                fence = None
            out.append(line)
            continue
        if fence is not None:
            out.append(line)
            continue
        holes = []

        def mask(m):
            holes.append(m.group(0))
            return f"\0{len(holes) - 1}\0"

        masked = _CODE.sub(mask, line)
        masked = _LINK.sub(lambda m: "](" + fn(m.group(1)) + m.group(2) + ")", masked)
        out.append(re.sub(r"\0(\d+)\0", lambda m: holes[int(m.group(1))], masked))
    return out


def shift_headings(chunk, delta):
    out = []
    heading_lines = {i for i, k, _ in scan(chunk) if k == "heading"}
    for i, line in enumerate(chunk):
        if i in heading_lines:
            n = len(line) - len(line.lstrip("#"))
            line = "#" * (n + delta) + line[n:]
        out.append(line)
    return out


def covers(file, heads):
    if file in COVERS:
        return COVERS[file]
    names = []
    for h in heads:
        m = re.match(r"(.*?) \((`[^)]*`)(?:, `[^)]*`)*\)$", h)
        names.append(m.group(2) if len(heads) == 1 and m else re.sub(r" \(.*$", "", h))
    return ", ".join(names)


def pages_block():
    rows = ["| Page | Covers |", "|---|---|"]
    for file, title, _, heads in PAGES:
        rows.append(f"| [{title}]({file}.md) | {covers(file, heads)} |")
    return [
        PAGES_MARKER,
        "",
        "Each page below holds one module, or a few small ones, of the sections that follow.",
        "",
        *rows,
        "",
    ]


def split(text, outdir):
    lines = text.split("\n")
    assert lines[-1] == ""
    lines.pop()
    head, chunks = sections(lines)
    page_of = {}
    for file, _, _, heads in PAGES:
        for h in heads:
            for _, k, d in scan(chunks[h]):
                if k == "heading":
                    page_of[slug(d[1])] = file
    page_of_all = dict(page_of)
    for _, k, d in scan(head):
        if k == "heading":
            page_of_all[slug(d[1])] = "index"
    assert {n for _, n in [(0, h) for p in PAGES for h in p[3]]} == set(chunks)

    def rewrite(here):
        def fn(dest):
            if dest.startswith("#"):
                target = page_of_all[dest[1:]]
                return dest if target == here else f"{target}.md{dest}" if target != "index" else f"index.md{dest}"
            if re.match(r"[a-z][a-z0-9+.-]*:", dest):
                return dest
            return "../" + dest.removeprefix("./")
        return fn

    outdir.mkdir(parents=True, exist_ok=True)
    # index: the original head, with the page list before "## Component Hierarchy".
    idx_head = trim(head) + [""]
    at = next(i for i, k, d in scan(idx_head) if k == "heading" and d[1] == "Component Hierarchy")
    mapped = map_links(idx_head, rewrite("index"))
    body = trim(mapped[:at] + pages_block() + mapped[at:])
    (outdir / "index.md").write_text("\n".join(body) + "\n")

    for file, title, desc, heads in PAGES:
        parts = [trim(chunks[h]) for h in heads]
        merged = []
        for p in parts:
            merged += (["" ] if merged else []) + p
        if SINGLE(heads):
            merged = shift_headings(merged, -1)
            text_ = front(desc) + "\n".join(map_links(merged, rewrite(file))) + "\n"
        else:
            text_ = front(desc) + f"# {title}\n\n" + "\n".join(map_links(merged, rewrite(file))) + "\n"
        (outdir / f"{file}.md").write_text(text_)
    return page_of_all


def unfront(text):
    m = re.match(r"---\ndescription: >-\n  [^\n]*\n---\n\n", text)
    assert m, "front matter"
    return text[m.end():]


def verify(orig_text, outdir):
    lines = orig_text.split("\n")
    assert lines[-1] == ""
    lines.pop()
    head, chunks = sections(lines)
    page_of = {}
    for file, _, _, heads in PAGES:
        for h in heads:
            for _, k, d in scan(chunks[h]):
                if k == "heading":
                    page_of[slug(d[1])] = file
    for _, k, d in scan(head):
        if k == "heading":
            page_of[slug(d[1])] = "index"

    def dests(chunk):
        found = []
        map_links(chunk, lambda d: found.append(d) or d)
        return found

    def check_pair(old_dest, new_dest, here):
        if old_dest.startswith("#"):
            target = page_of[old_dest[1:]]
            want = old_dest if target == here else f"{target}.md{old_dest}"
            assert new_dest == want, (old_dest, new_dest, here)
        elif re.match(r"[a-z][a-z0-9+.-]*:", old_dest):
            assert new_dest == old_dest
        else:
            assert new_dest == "../" + old_dest.removeprefix("./"), (old_dest, new_dest)

    def masked(chunk):
        return map_links(chunk, lambda d: "X")

    # Every old file is accounted for: the index chunk and the sections.
    seen_slugs = []
    rebuilt_parts = []

    index_new = (outdir / "index.md").read_text()
    assert index_new.endswith("\n")
    idx_lines = index_new[:-1].split("\n")
    a = idx_lines.index(PAGES_MARKER)
    b = next(i for i, l in enumerate(idx_lines) if l == "## Component Hierarchy")
    block = idx_lines[a:b]
    assert block == pages_block(), "pages block"
    idx_old = idx_lines[:a] + idx_lines[b:]
    expect = trim(head) 
    assert masked(idx_old) == masked(expect), "index body differs"
    for o, n in zip(dests(expect), dests(idx_old)):
        check_pair(o, n, "index")
    rebuilt_parts.append(expect)

    for file, title, desc, heads in PAGES:
        new = unfront((outdir / f"{file}.md").read_text())
        assert new.endswith("\n")
        new_lines = new[:-1].split("\n")
        if SINGLE(heads):
            new_lines = shift_headings(new_lines, +1)
        else:
            assert new_lines[0] == f"# {title}" and new_lines[1] == ""
            new_lines = new_lines[2:]
        old = []
        for h in heads:
            old += ([""] if old else []) + trim(chunks[h])
        assert masked(new_lines) == masked(old), f"{file}: body differs"
        for o, n in zip(dests(old), dests(new_lines)):
            check_pair(o, n, file)
        assert len(dests(old)) == len(dests(new_lines))
        for _, k, d in scan(new_lines):
            if k == "heading":
                seen_slugs.append(slug(d[1]))
        rebuilt_parts += [trim(chunks[h]) for h in heads]

    # The pages tile the page: head + every section, in order, one blank line apart.
    rebuilt = "\n\n".join("\n".join(p) for p in rebuilt_parts) + "\n"
    assert rebuilt == orig_text, "pages do not tile the original"
    old_slugs = [slug(d[1]) for _, k, d in scan(lines) if k == "heading"]
    # headings of the old page appear exactly once across the new pages, plus the new titles
    all_new = list(seen_slugs)
    for _, k, d in scan(head):
        if k == "heading":
            all_new.append(slug(d[1]))
    from collections import Counter
    c = Counter(all_new)
    for s_ in old_slugs:
        assert c[s_] == 1, ("anchor", s_, c[s_])
    return len(old_slugs)


if __name__ == "__main__":
    cmd, src, dst = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    text = Path(src).read_text()
    if cmd == "split":
        split(text, dst)
    else:
        print("ok, headings mapped:", verify(text, dst))
