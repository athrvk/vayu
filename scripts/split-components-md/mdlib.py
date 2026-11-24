"""Shared helpers for the COMPONENTS.md reshape and split scripts."""
import importlib.util
import re

spec = importlib.util.spec_from_file_location("dl", "scripts/docs-lint.py")
dl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dl)
table_cells = dl.table_cells

from pymdownx.slugs import slugify

_slug = slugify(case="lower")


def slug(text):
    return _slug(text, "-")


def scan(lines):
    """Yield (index, kind, data) for headings and table rows outside fences."""
    fence = None
    for i, line in enumerate(lines):
        opener = dl._FENCE.match(line)
        if opener:
            marks = opener.group(1)
            if fence is None:
                fence = marks
            elif marks[0] == fence[0] and len(marks) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        m = re.match(r"(#{1,6}) (.*)", line)
        if m:
            yield i, "heading", (len(m.group(1)), m.group(2))
        elif line.lstrip().startswith("|"):
            yield i, "row", None


_BLOCK_START = re.compile(r"\s*([-+*]|\d+[.)])\s|#{1,6}\s|>|`{3}|~{3}|\|")


def sentences(text):
    """Split text on '. ' (and '! ', '? ') outside code spans, brackets and parens."""
    out, start, i, depth = [], 0, 0, 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "`":
            run = len(text[i:]) - len(text[i:].lstrip("`"))
            close = text.find("`" * run, i + run)
            i = i + run if close == -1 else close + run
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
        elif c in ".!?" and depth == 0 and i + 1 < n and text[i + 1] == " ":
            nxt = text[i + 2 : i + 3]
            before = text[max(0, i - 4) : i + 1]
            abbrev = re.search(r"(?:\be\.g|\bi\.e|\bvs|\betc|\bcf)\.$", before)
            if nxt and (nxt.isupper() or nxt in "`*_") and not abbrev:
                out.append(text[start : i + 1])
                start = i + 2
        i += 1
    out.append(text[start:])
    return out


def wrap_sentences(text):
    """Return text as lines such that ' '.join(lines) == text."""
    parts = sentences(text)
    lines = []
    for part in parts:
        if lines and _BLOCK_START.match(part):
            lines[-1] += " " + part
        else:
            lines.append(part)
    assert " ".join(lines) == text
    return lines
