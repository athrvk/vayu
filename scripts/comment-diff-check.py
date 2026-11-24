#!/usr/bin/env python3
"""
Proves a change touched comments and nothing else (#3868).

For every source file the diff between --base and --head touches (the scope of
comment-lint.py), it strips the comments from the file at each end and requires
the two token streams to be identical, then counts the directives that carry
meaning inside a comment and requires the same counts at both ends. Output is
meant to be pasted into a pull request description.

Comments are read as the language reads them, not as a regex would: a `//` or
`/*` inside a string, a template literal (and its `${}` expressions), a regex
literal or a C++ raw string is not a comment. A comment between two tokens
separates them like whitespace; whitespace is compared only where it keeps two
operator characters apart (`+ +` and `++`), so a reflow is not a difference and
a token change is. In a `.tsx` file a JSX `{/* ... */}` (braces holding nothing
but comments) is a comment that is also a JSX child, so the whole unit may be
removed or only its comment.

Directives counted, per file, at both ends: `NOLINT*`, `clang-format off|on`,
`eslint-disable*`, `@ts-expect-error` (and `@ts-ignore`, `@ts-nocheck`,
`@ts-check`), `@deliberate`, `@TODO`, `@FIXME`, `/// <reference`,
`@vite-ignore`, `v8 ignore` (and `istanbul ignore`, `c8 ignore`),
`prettier-ignore`, `@deprecated`, and the license header's two lines. Deleting
one is a difference even when the stripped code is identical, because a
suppression's reason is what a test or a tool reads.

A `//` right after a `:` is a URL, not a comment (`case 1://x` is read as code).

Known limits, all read the same way at both ends: a `/*`, or a `//` that does not
follow a `:`, in JSX text outside braces is read as a comment, a backtick in JSX text starts a
template literal (comments inside the region it swallows read as code, so
removing one is reported as a difference), and a `/` after `)` or `}` is read as
division. A line break is not a token, so removing a multi-line block comment between `return` and its
operand (which ends the statement under automatic semicolon insertion) is not
seen. A file the diff adds, deletes or renames is a difference.

Usage: comment-diff-check.py --base REF [--head REF] [--root DIR]

  --base REF   the commit the change started from; the merge-base of REF and
               --head is what is compared, so a base branch that has moved on
               does not show up as part of the change
  --head REF   the commit with the change (default: HEAD)
  --root DIR   the repository root (default: the parent of scripts/)

Exits 0 when every touched source file differs in comments only, 1 on a
difference (the file and the first differing token are named), 2 on a bad
reference, a git failure, or a diff that touches no source file at all.
"""

import argparse
import bisect
import importlib.util
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

Token = tuple[str, str, int]  # kind, text, offset

_SPEC = importlib.util.spec_from_file_location(
    "comment_lint", Path(__file__).resolve().with_name("comment-lint.py")
)
_LINT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_LINT)
in_scope = _LINT.in_scope

_WORD = re.compile(r"[A-Za-z0-9_$\u0080-\U0010ffff]+")
_SPACE = re.compile(r"\s+")
_RAW_PREFIXES = ("R", "u8R", "uR", "UR", "LR")
_REGEX_AFTER_WORD = frozenset(
    ("return", "typeof", "case", "do", "else", "in", "of", "instanceof", "new", "delete", "void")
    + ("throw", "yield", "await")
)
_REGEX_AFTER_PUNCT = frozenset("(,=:[!&|?{;+-*%<>~^")
_OPERATORS = frozenset("+-*/%<>=&|^!?:.~")
_CONTEXT_TOKENS = 4


class CheckError(RuntimeError):
    pass


class Lexer:
    """Splits source into word, punct, lit, tpl, ws and comment tokens.

    `lit` is a string, a regex or a raw string, `tpl` one chunk of a template
    literal (the text between its `${}` substitutions, whose own tokens follow
    in order). An unterminated quote is a lone punct, so JSX text such as
    `Don't` costs one line and not the rest of the file.
    """

    def __init__(self, text: str, language: str):
        self.s = text
        self.n = len(text)
        self.i = 0
        self.cpp = language == "cpp"
        self.out: list[Token] = []

    def run(self) -> list[Token]:
        if not self.cpp and self.s.startswith("#!"):
            self._emit("lit", 0, self._line_end(0))
        self._code(in_template=False)
        return self.out

    def _emit(self, kind: str, start: int, end: int) -> None:
        self.out.append((kind, self.s[start:end], start))
        self.i = end

    def _line_end(self, start: int) -> int:
        end = self.s.find("\n", start)
        return self.n if end == -1 else end

    def _code(self, in_template: bool) -> None:
        depth = 0
        while self.i < self.n:
            c = self.s[self.i]
            if c == "}" and in_template and depth == 0:
                return
            depth += (c == "{") - (c == "}")
            self._step(c)

    def _step(self, c: str) -> None:
        s, i = self.s, self.i
        if c.isspace():
            self._emit("ws", i, _SPACE.match(s, i).end())
        elif s.startswith("//", i) and s[i - 1 : i] != ":":
            self._line_comment()
        elif s.startswith("/*", i):
            end = s.find("*/", i + 2)
            self._emit("comment", i, self.n if end == -1 else end + 2)
        elif c in "\"'":
            self._quoted(c)
        elif c == "`" and not self.cpp:
            self._template()
        elif _WORD.match(c):
            self._word()
        elif c == "/" and self._try_regex():
            return  # a regex literal, emitted
        else:
            self._emit("punct", i, i + 1)

    def _line_comment(self) -> None:
        end = self._line_end(self.i + 2)
        while self.cpp and end < self.n and self._continues(end):
            end = self._line_end(end + 1)
        self._emit("comment", self.i, end)

    def _continues(self, newline: int) -> bool:
        """Whether the backslash before this newline splices the next line on (C++ only)."""
        before = newline - 1
        if before >= 0 and self.s[before] == "\r":
            before -= 1
        return before >= 0 and self.s[before] == "\\"

    def _quoted(self, quote: str) -> None:
        j = self.i + 1
        while j < self.n:
            c = self.s[j]
            if c == "\\":
                j += 2
            elif c == quote:
                self._emit("lit", self.i, j + 1)
                return
            elif c == "\n":
                break
            else:
                j += 1
        self._emit("punct", self.i, self.i + 1)

    def _template(self) -> None:
        chunk = self.i
        j = self.i + 1
        while j < self.n:
            c = self.s[j]
            if c == "\\":
                j += 2
            elif c == "`":
                self._emit("tpl", chunk, j + 1)
                return
            elif self.s.startswith("${", j):
                self._emit("tpl", chunk, j + 2)
                self._code(in_template=True)
                chunk = self.i
                j = self.i + 1  # past the `}` that ended the substitution
            else:
                j += 1
        self._emit("tpl", chunk, self.n)

    def _word(self) -> None:
        j = _WORD.match(self.s, self.i).end()
        if self.cpp and self.s[self.i].isdigit():
            while self.s[j : j + 1] == "'" and self.s[j + 1 : j + 2].isalnum():
                j = _WORD.match(self.s, j + 1).end()  # a digit separator, `1'000'000`
        if self.cpp and self.s[self.i : j] in _RAW_PREFIXES and self.s[j : j + 1] == '"':
            end = self._raw_string_end(j)
            if end is not None:
                self._emit("lit", self.i, end)
                return
        self._emit("word", self.i, j)

    def _raw_string_end(self, quote: int) -> int | None:
        """The end of `R"delim( ... )delim"` whose opening quote is at `quote`."""
        paren = self.s.find("(", quote + 1, quote + 18)
        if paren == -1:
            return None
        delimiter = self.s[quote + 1 : paren]
        if re.search(r'[\s)\\"]', delimiter):
            return None
        close = self.s.find(f'){delimiter}"', paren + 1)
        return None if close == -1 else close + len(delimiter) + 2

    def _regex_allowed(self) -> bool:
        previous = self.out[-1] if self.out else None
        if previous is None:
            return True
        if previous[0] == "punct" and previous[1] == "<":
            return False  # `</div>`: the `/` closes a JSX tag
        for kind, text, _ in reversed(self.out):
            if kind in ("ws", "comment"):
                continue
            if kind == "punct":
                return text in _REGEX_AFTER_PUNCT
            return kind == "word" and text in _REGEX_AFTER_WORD
        return True

    def _try_regex(self) -> bool:
        if self.cpp or self.s.startswith("/>", self.i) or not self._regex_allowed():
            return False
        j = self.i + 1
        in_class = False
        while j < self.n:
            c = self.s[j]
            if c == "\\":
                j += 2
                continue
            if c == "\n":
                return False
            if c == "/" and not in_class:
                self._emit("lit", self.i, j + 1)
                return True
            in_class = (in_class or c == "[") and c != "]"
            j += 1
        return False


def language_of(path: str) -> str:
    return "cpp" if path.endswith((".cpp", ".hpp", ".h")) else "js"


def tokenize(text: str, path: str) -> list[Token]:
    return Lexer(text, language_of(path)).run()


def drop_comment_only_braces(tokens: list[Token]) -> list[Token]:
    """Remove each `{` ... `}` that holds comments and nothing else."""
    kept = []
    i = 0
    while i < len(tokens):
        j = i + 1
        comments = 0
        if tokens[i][:2] == ("punct", "{"):
            while j < len(tokens) and tokens[j][0] in ("ws", "comment"):
                comments += tokens[j][0] == "comment"
                j += 1
        if comments and j < len(tokens) and tokens[j][:2] == ("punct", "}"):
            i = j + 1
            continue
        kept.append(tokens[i])
        i += 1
    return kept


def _keeps_apart(left: Token, right: Token) -> bool:
    """Whether whitespace between these two tokens is what stops them being one operator.

    Two words are never one token, so only operator characters need it: `+ +` and `++`.
    """
    both_punct = left[0] == right[0] == "punct"
    return both_punct and left[1] in _OPERATORS and right[1] in _OPERATORS


def significant(tokens: list[Token]) -> list[tuple[str, int]]:
    """(text, offset) for each token that is code, with a ` ` where whitespace or a
    comment is what keeps two tokens from becoming one."""
    out: list[tuple[str, int]] = []
    previous: Token | None = None
    separated = False
    for token in tokens:
        if token[0] in ("ws", "comment"):
            separated = True
            continue
        if separated and previous is not None and _keeps_apart(previous, token):
            out.append((" ", token[2]))
        out.append((token[1], token[2]))
        previous, separated = token, False
    return out


def first_difference(base: list, head: list) -> int | None:
    for index, (left, right) in enumerate(zip(base, head)):
        if left[0] != right[0]:
            return index
    return None if len(base) == len(head) else min(len(base), len(head))


class Comparison:
    """One file's code at the two ends: the streams, and where they first differ."""

    def __init__(self, path: str, base: str, head: str):
        self.path = path
        self.base_text = base
        self.head_text = head
        base_tokens, head_tokens = tokenize(base, path), tokenize(head, path)
        self.comments = (_count_comments(base_tokens), _count_comments(head_tokens))
        self.base, self.head = significant(base_tokens), significant(head_tokens)
        self.index = first_difference(self.base, self.head)
        if self.index is not None and path.endswith(".tsx"):
            self._allow_jsx_comment_units(base_tokens, head_tokens)

    def _allow_jsx_comment_units(self, base_tokens: list[Token], head_tokens: list[Token]) -> None:
        base = significant(drop_comment_only_braces(base_tokens))
        head = significant(drop_comment_only_braces(head_tokens))
        index = first_difference(base, head)
        if index is None or index > self.index:
            # Blame the later difference: the earlier one is the `{/* */}` unit itself.
            self.base, self.head, self.index = base, head, index


def _count_comments(tokens: list[Token]) -> int:
    return sum(kind == "comment" for kind, _, _ in tokens)


DIRECTIVES = (
    re.compile(r"\bNOLINT\w*"),
    re.compile(r"\bclang-format\s+(?:off|on)\b"),
    re.compile(r"\beslint-disable[\w-]*"),
    re.compile(r"@ts-(?:expect-error|ignore|nocheck|check)\b"),
    re.compile(r"@(?:deliberate|TODO|FIXME|deprecated|vite-ignore)\b"),
    re.compile(r"///\s*<reference"),
    re.compile(r"\b(?:v8|istanbul|c8) ignore\b"),
    re.compile(r"\bprettier-ignore\b"),
    re.compile(r"Copyright \(c\)"),
    re.compile(r"is licensed under\b"),
)


def directive_counts(text: str) -> Counter:
    counts: Counter = Counter()
    for pattern in DIRECTIVES:
        counts.update(re.sub(r"\s+", " ", match.group(0)) for match in pattern.finditer(text))
    return counts


def line_of(text: str, offset: int) -> int:
    starts = [0] + [m.end() for m in re.finditer("\n", text)]
    return bisect.bisect_right(starts, offset)


def describe_difference(comparison: Comparison) -> list[str]:
    index = comparison.index

    def at(stream: list, text: str) -> str:
        if index >= len(stream):
            return "the end of the file"
        token, offset = stream[index]
        return f"`{token[:60]}` (line {line_of(text, offset)})"

    def window(stream: list) -> str:
        shown = stream[max(0, index - _CONTEXT_TOKENS) : index + _CONTEXT_TOKENS + 1]
        return "".join(token for token, _ in shown).replace("\n", " ")[:200]

    where = f"base has {at(comparison.base, comparison.base_text)}, "
    where += f"head has {at(comparison.head, comparison.head_text)}"
    return [
        f"{comparison.path}: code differs at token {index}: {where}",
        f"base: ...{window(comparison.base)}...",
        f"head: ...{window(comparison.head)}...",
    ]


def describe_directives(path: str, base: Counter, head: Counter) -> list[str]:
    return [
        f"{path}: directive `{name}` appears {base[name]} time(s) at base, {head[name]} at head"
        for name in sorted(set(base) | set(head))
        if base[name] != head[name]
    ]


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), "-c", "core.quotepath=off", *args],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise CheckError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def show(root: Path, ref: str, path: str) -> str:
    return git(root, "show", f"{ref}:{path}").decode("utf-8", errors="replace")


def touched_files(root: Path, base: str, head: str) -> list[tuple[str, str]]:
    """(status, path) for each file the change touches; a rename reads as delete + add."""
    raw = git(root, "diff", "--name-status", "--no-renames", "-z", base, head).split(b"\0")
    fields = [field.decode() for field in raw if field]
    return list(zip(fields[0::2], fields[1::2], strict=True))


def check_file(root: Path, status: str, path: str, base: str, head: str) -> tuple[list[str], str]:
    """(problems, one-line summary) for one touched in-scope file."""
    if status == "A":
        return [f"{path}: added; a comment-only change adds no source file"], ""
    if status == "D":
        return [f"{path}: deleted; a comment-only change deletes no source file"], ""
    before, after = show(root, base, path), show(root, head, path)
    comparison = Comparison(path, before, after)
    problems = []
    if comparison.index is not None:
        problems += describe_difference(comparison)
    counts_before, counts_after = directive_counts(before), directive_counts(after)
    problems += describe_directives(path, counts_before, counts_after)
    if problems:
        return problems, ""
    gone, kept = comparison.comments
    code_tokens = sum(text != " " for text, _ in comparison.head)
    return [], (
        f"{path}: {code_tokens} code tokens, comments {gone} -> {kept}, "
        f"{sum(counts_before.values())} directive(s)"
    )


def run(root: Path, base: str, head: str) -> tuple[int, list[str]]:
    merge_base = git(root, "merge-base", base, head).decode().strip()
    touched = touched_files(root, merge_base, head)
    checked = [(status, path) for status, path in touched if in_scope(path)]
    skipped = [path for _, path in touched if not in_scope(path)]
    if not checked:
        raise CheckError(f"the change touches no source file the lint scope covers ({len(skipped)} other)")

    head_sha = git(root, "rev-parse", head).decode().strip()
    lines = [f"comment-diff-check: {merge_base[:12]} .. {head_sha[:12]}"]
    failed = 0
    for status, path in checked:
        problems, summary = check_file(root, status, path, merge_base, head)
        if problems:
            failed += 1
            lines.append(f"  FAIL  {problems[0]}")
            lines += [f"        {problem}" for problem in problems[1:]]
        else:
            lines.append(f"  ok    {summary}")
    if skipped:
        lines.append(f"  not checked (outside comment-lint's scope): {', '.join(skipped)}")
    if failed:
        lines.append(f"comment-diff-check: {failed} of {len(checked)} file(s) differ beyond comments")
        return 1, lines
    lines.append(f"comment-diff-check: {len(checked)} file(s) differ in comments only")
    return 0, lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        code, lines = run(args.root, args.base, args.head)
    except (CheckError, OSError) as error:
        print(f"comment-diff-check: {error}", file=sys.stderr)
        return 2
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
