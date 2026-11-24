#!/usr/bin/env python3
"""
scripts/comment-diff-check.py: a change that only deletes comments passes, and a
change to one code token or one directive does not. The checker is the proof a
comment-trimming pull request carries, so the two ways it can fail quietly are
the ones tested: reading code as a comment (a `//` in a string, a template, a
regex or a raw string hides a change) and reading a comment as code (a trim is
reported as a change and the pass cannot be proven).

Mutation checks: make `Lexer._quoted` return a punct for every quote and the
string cases fail; drop the `${}` recursion in `Lexer._template` and the
template-expression cases fail; make `_raw_string_end` return None and the raw
string cases fail; drop `drop_comment_only_braces` from `_allow_jsx_comment_units`
and the JSX unit cases fail; remove the `directive_counts` comparison in
`check_file` and the directive cases fail; use `base` instead of `merge_base` in
`run` and the moved-base case fails; make `_keeps_apart` always False and the
merged-token cases fail.

Run: python3 scripts/test/comment_diff_check_test.py
"""

import contextlib
import importlib.util
import io
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "comment-diff-check.py"

spec = importlib.util.spec_from_file_location("comment_diff_check", SCRIPT)
cdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cdc)

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok    {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def code_differs(base: str, head: str, path: str = "a.ts") -> bool:
    """Whether the comment-stripped code of `base` and `head` differs."""
    return cdc.Comparison(path, base, head).index is not None


def same(name: str, base: str, head: str, path: str = "a.ts") -> None:
    check(f"comment-only: {name}", not code_differs(base, head, path))


def differs(name: str, base: str, head: str, path: str = "a.ts") -> None:
    check(f"code change seen: {name}", code_differs(base, head, path))


print("deleting a comment changes nothing")
same("a line comment", "a();\n// note\nb();\n", "a();\nb();\n")
same("a trailing comment", "a(); // note\nb();\n", "a();\nb();\n")
same("a block comment", "a();\n/* note */\nb();\n", "a();\nb();\n")
same("a doc block", "/**\n * Note.\n */\nfunction f() {}\n", "function f() {}\n")
same("a comment in a call", "f(a, /* note */ b);\n", "f(a, b);\n")
same("a comment in empty parens", "f(/* none */);\n", "f();\n")
same("a comment between operators", "a + /* c */ b;\n", "a + b;\n")
same("an emptied comment block", "a();\n\n\n// one\n// two\n\n\nb();\n", "a();\n\nb();\n")
same("every comment of a file", "// x\na(); // y\n/* z */\n", "a();\n")
same("a reflow of whitespace", "a+b;\n", "a  +  b;\n")
same("an apostrophe in a comment", "// don't\na();\n", "a();\n")
same("a quote in a comment", '// say "hi\na();\n', "a();\n")
same("CRLF line endings", "a();\r\n// note\r\nb();\r\n", "a();\r\nb();\r\n")
same("an unterminated block comment", "a();\n/* open\n", "a();\n")
same("a hashbang line is kept as code", "#!/usr/bin/env node\n// n\na();\n", "#!/usr/bin/env node\na();\n", "a.mjs")

print("a code change beside a comment is seen")
differs("an operator", "a + b; // c\n", "a - b;\n")
differs("an identifier", "// c\nfoo();\n", "bar();\n")
differs("a deleted character", "foo(); // c\n", "fo();\n")
differs("an added statement", "// c\na();\n", "a();\nb();\n")
differs("a deleted statement", "a();\nb(); // c\n", "a();\n")
differs("a literal", "x = 1; // c\n", "x = 2;\n")
differs("code changed along with its comment", "a(); // one\n", "b(); // two\n")
check("a changed comment text alone is comment-only", not code_differs("a(); // one\n", "a(); // two\n"))
check("an added comment is comment-only", not code_differs("a();\n", "// new\na();\n"))
differs("tokens merged by deleting a comment between them", "a/**/b;\n", "ab;\n")
same("a comment between two words", "a /* c */ b;\n", "a b;\n")
differs("a comment between two words deleted with its spaces", "a /* c */ b;\n", "ab;\n")
differs("two plus signs merged by deleting a comment between them", "a +/**/+ b;\n", "a ++ b;\n")
same("two plus signs kept apart", "a + /**/ + b;\n", "a + + b;\n")
differs("two plus signs kept apart and then joined", "a + + b;\n", "a ++ b;\n")
differs("space added inside a word", "abc();\n", "ab c();\n")
differs("a trailing token after the last comment", "a(); // c\n", "a(); b();\n")

print("a comment marker inside a string is not a comment")
differs("a double-quoted string", 'x = "a // b";\n', 'x = "a // c";\n')
differs("a single-quoted string", "x = 'a // b';\n", "x = 'a // c';\n")
differs("a block opener in a string", 'x = "a /* b";\n', 'x = "a /* c";\n')
differs("a URL in a string", 'u = "https://a.example/x";\n', 'u = "https://a.example/y";\n')
differs("a string with an escaped quote", 'x = "a \\" // b";\n', 'x = "a \\" // c";\n')
differs("a string after the comment-like text", 'x = "//"; y = "z";\n', 'x = "//"; y = "w";\n')
differs("a template literal", "x = `a // b`;\n", "x = `a // c`;\n")
differs("a multi-line template literal", "x = `a\n// b\nc`;\n", "x = `a\n// c\nc`;\n")
differs("a template literal's block opener", "x = `a /* b`;\n", "x = `a /* c`;\n")
differs("text after a template substitution", "x = `${a} // b`;\n", "x = `${a} // c`;\n")
differs("a nested template", "x = `${`// a`}`;\n", "x = `${`// b`}`;\n")
differs("a string inside a substitution", "x = `${'// a'}`;\n", "x = `${'// b'}`;\n")
differs("a brace inside a substitution's object", "x = `${{a: 1}.a} // b`;\n", "x = `${{a: 1}.a} // c`;\n")
same("a comment inside a template substitution", "x = `${a /* c */}`;\n", "x = `${a}`;\n")
same("a template followed by a comment", "x = `a`; // c\n", "x = `a`;\n")
differs("a regex literal", "r = /a\\/\\/b/g;\n", "r = /a\\/\\/c/g;\n")
differs("a regex with a slash in a class", "r = /[/]\\/\\//;\n", "r = /[/]\\/\\/x/;\n")
differs("a regex ending in an escaped slash", "r = /a\\//; y = 1;\n", "r = /a\\//; y = 2;\n")
differs("a regex ending in an escaped slash after return",
        "function f() { return /a\\//; y = 1; }\n", "function f() { return /a\\//; y = 2; }\n")
differs("a regex after return", "function f() { return /\\/\\/x/; }\n", "function f() { return /\\/\\/y/; }\n")
same("division is not a regex", "x = a / b; // c\n", "x = a / b;\n")
same("division after a parenthesis", "x = (a) / 2; // c\n", "x = (a) / 2;\n")
same("a closing JSX tag is not a regex", "x = <b>t</b>; // c\n", "x = <b>t</b>;\n", "a.tsx")
differs("an apostrophe in JSX text costs one line, not the file",
        "x = <p>Don't</p>;\ny = 1;\n", "x = <p>Don't</p>;\ny = 2;\n", "a.tsx")
same("a comment after an apostrophe line", "x = <p>Don't</p>;\n// c\ny = 1;\n", "x = <p>Don't</p>;\ny = 1;\n", "a.tsx")
differs("a URL in JSX text", "x = <a>https://a.example/x</a>;\n", "x = <a>https://a.example/y</a>;\n", "a.tsx")

print("C++ strings and literals")
differs("a raw string", 'auto s = R"(// a)";\n', 'auto s = R"(// b)";\n', "a.cpp")
differs("a raw string with a delimiter", 'auto s = R"JS(\n// a\n)JS";\n', 'auto s = R"JS(\n// b\n)JS";\n', "a.cpp")
differs("a raw string holding a quote and a paren", 'auto s = R"x(a)" // b)x";\n', 'auto s = R"x(a)" // c)x";\n', "a.cpp")
differs("a prefixed raw string", 'auto s = u8R"(/* a)";\n', 'auto s = u8R"(/* b)";\n', "a.cpp")
same("a comment after a raw string", 'auto s = R"(x)"; // c\n', 'auto s = R"(x)";\n', "a.cpp")
differs("a C++ string", 'auto s = "a // b";\n', 'auto s = "a // c";\n', "a.hpp")
differs("a char literal holding a slash", "char c = '/'; char d = 'x';\n", "char c = '/'; char d = 'y';\n", "a.cpp")
differs("a char literal holding a quote", "char c = '\"'; int x = 1;\n", "char c = '\"'; int x = 2;\n", "a.cpp")
same("a digit separator is not a char literal", "int n = 1'000; // it's\nint m = 2;\n", "int n = 1'000;\nint m = 2;\n", "a.cpp")
same("two digit separators", "int n = 1'000'000; // it's\n", "int n = 1'000'000;\n", "a.cpp")
differs("code after a digit separator", "int n = 1'000; int m = 2;\n", "int n = 1'000; int m = 3;\n", "a.cpp")
same("a continued line comment is all comment", "// a \\\nint x;\nint y;\n", "int y;\n", "a.cpp")
differs("a line comment ends at an unescaped newline", "// a\nint x;\nint y;\n", "int y;\n", "a.cpp")
differs("a backslash ends a JS line comment all the same", "// a \\\nx();\ny();\n", "y();\n", "a.ts")
same("a continued comment with CRLF", "// a \\\r\nint x;\r\nint y;\r\n", "int y;\r\n", "a.cpp")
same("an include path is code", '#include "a/b.hpp"\n// c\nint x;\n', '#include "a/b.hpp"\nint x;\n', "a.cpp")
same("a scope operator is not a comment", "int x = a::b; // c\n", "int x = a::b;\n", "a.cpp")
differs("a // right after a colon is not a comment", "x = a://b;\n", "x = a://c;\n", "a.cpp")

print("a JSX comment is one unit")
unit = "const x = (\n\t<div>\n\t\t{/* note */}\n\t\t<b />\n\t</div>\n);\n"
without = "const x = (\n\t<div>\n\t\t<b />\n\t</div>\n);\n"
same("the whole {/* */} removed", unit, without, "a.tsx")
same("only its comment removed, the braces kept", unit, unit.replace("/* note */", ""), "a.tsx")
same("a {// } line-comment container removed", unit.replace("{/* note */}", "{\n// note\n}"), without, "a.tsx")
same("two comments in one container", unit.replace("/* note */", "/* a */ /* b */"), without, "a.tsx")
same("a container with a comment beside a trailing one", unit + "// c\n", unit, "a.tsx")
differs("a container holding code is not a comment", unit.replace("/* note */", "x"), without, "a.tsx")
differs("a container holding code and a comment", unit.replace("/* note */", "x /* note */"), without, "a.tsx")
differs("a code change beside a removed container",
        unit, without.replace("<b />", "<i />"), "a.tsx")
differs("the same removal of braces in a .ts file", "const f = () => {/* note */};\n", "const f = () => ;\n", "a.ts")
same("an empty body keeps its braces when the comment goes", "const f = () => { /* none */ };\n", "const f = () => { };\n", "a.ts")
same("the same in a .tsx file", "const f = () => { /* none */ };\n", "const f = () => { };\n", "a.tsx")
same("a comment in a JSX attribute list", "x = <a /* c */ b=\"1\" />;\n", 'x = <a b="1" />;\n', "a.tsx")

print("the first difference is named")
comparison = cdc.Comparison("a.ts", "a();\nb();\nc();\n", "a();\nb();\nd();\n")
text = "\n".join(cdc.describe_difference(comparison))
check("it names the path, both tokens and their lines",
      "a.ts: code differs" in text and "`c` (line 3)" in text and "`d` (line 3)" in text, text)
comparison = cdc.Comparison("a.tsx", unit, without.replace("<b />", "<i />"))
text = "\n".join(cdc.describe_difference(comparison))
check("a difference beside a removed JSX unit blames the real one, not the unit",
      "`b`" in text and "`i`" in text and "note" not in text.split("\n")[0], text)
comparison = cdc.Comparison("a.ts", "a();\n", "a();\nb();\n")
check("a head that runs on past the base is named", "the end of the file" in "\n".join(cdc.describe_difference(comparison)))

print("directives")
for marker in (
    "NOLINT",
    "NOLINTNEXTLINE(bugprone-x)",
    "NOLINTBEGIN",
    "NOLINTEND",
    "clang-format off",
    "clang-format on",
    "eslint-disable",
    "eslint-disable-next-line no-x",
    "eslint-disable-line",
    "@ts-expect-error reason",
    "@ts-ignore",
    "@deliberate",
    "@TODO",
    "@FIXME",
    "@deprecated use y",
    "@vite-ignore",
    "v8 ignore next",
    "istanbul ignore next",
    "prettier-ignore",
    "Copyright (c) 2026 A. Person",
    "This source code is licensed under the Apache 2.0 license",
):
    counts = cdc.directive_counts(f"// {marker}\ncode();\n")
    check(f"counted: {marker}", sum(counts.values()) == 1, str(counts))
check("a triple-slash reference is counted", sum(cdc.directive_counts('/// <reference types="vite/client" />\n').values()) == 1)
check("two on one line are two", sum(cdc.directive_counts("// NOLINT // NOLINT\n").values()) == 2)
check("variants are counted apart",
      cdc.directive_counts("// NOLINT\n") != cdc.directive_counts("// NOLINTNEXTLINE\n"))
check("ordinary prose is no directive", sum(cdc.directive_counts("// the lint is fine, enable it\n").values()) == 0)
check("a license header is counted once per line, not per file",
      sum(cdc.directive_counts("/**\n * Copyright (c) 2026 A\n *\n * This source code is licensed under the AGPL\n */\n").values()) == 2)
differences = cdc.describe_directives("a.cpp", cdc.directive_counts("// NOLINT\n"), cdc.directive_counts(""))
check("a lost directive is named with both counts", len(differences) == 1 and "NOLINT" in differences[0] and "1 time(s) at base, 0 at head" in differences[0], str(differences))
check("equal counts are no difference", cdc.describe_directives("a", cdc.directive_counts("// NOLINT\n"), cdc.directive_counts("x(); // NOLINT\n")) == [])


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.com",
         "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", *args],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def make_repo(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="comment-diff-test-"))
    git(root, "init", "-q")
    commit(root, files)
    return root


def commit(root: Path, files: dict[str, str | None], remove: tuple[str, ...] = ()) -> str:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for name in remove:
        (root / name).unlink()
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "change")
    return git(root, "rev-parse", "HEAD")


def run(root: Path, *args: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = cdc.main(["--root", str(root), *args])
    return code, out.getvalue()


CPP = "engine/src/a.cpp"
TS = "app/src/a.ts"
TSX = "app/src/b.tsx"
BASE_FILES = {
    CPP: "// NOLINT\nint f() { return 1; } // note\n",
    TS: "// note\nexport const a = 1;\n",
    TSX: "export const b = <div>{/* note */}<b /></div>;\n",
}

print("the command line, against a real diff")
root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {TS: "export const a = 1;\n", TSX: "export const b = <div><b /></div>;\n"})
code, out = run(root, "--base", base)
check("a diff that deletes comments exits 0", code == 0, out)
check("it names the files it proved and the verdict",
      f"ok    {TS}" in out and f"ok    {TSX}" in out and "2 file(s) differ in comments only" in out, out)
check("it prints the comment counts, for the pull request description", "comments 1 -> 0" in out, out)

root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {TS: "// note\nexport const a = 2;\n"})
code, out = run(root, "--base", base)
check("a diff that changes one code token exits 1", code == 1, out)
check("it names the file and the first differing token",
      f"FAIL  {TS}: code differs" in out and "`1`" in out and "`2`" in out and "1 of 1 file(s) differ beyond comments" in out, out)

root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {CPP: "int f() { return 1; } // note\n"})
code, out = run(root, "--base", base)
check("a diff that deletes one NOLINT exits 1 though the code is the same", code == 1, out)
check("it names the directive", "directive `NOLINT` appears 1 time(s) at base, 0 at head" in out and "code differs" not in out, out)

root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {CPP: "// NOLINTNEXTLINE\nint f() { return 1; } // note\n"})
code, out = run(root, "--base", base)
check("a directive swapped for another exits 1", code == 1 and "NOLINTNEXTLINE" in out, out)

root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {CPP: "// NOLINT\nint f() { return 1; }\n"})
code, out = run(root, "--base", base)
check("deleting a comment that is no directive beside a directive exits 0", code == 0, out)

root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
head = commit(root, {TS: "export const a = 1;\n"})
commit(root, {TS: "export const a = 1;\n", "app/src/c.ts": "export const c = 1;\n"})
code, out = run(root, "--base", base, "--head", head)
check("--head names the end of the comparison", code == 0 and "app/src/c.ts" not in out, out)
code, out = run(root, "--base", base)
check("HEAD is the default head: an added file is a difference", code == 1 and "app/src/c.ts: added" in out, out)

print("the base branch moving on is not part of the change")
root = make_repo(BASE_FILES)
fork = git(root, "rev-parse", "HEAD")
git(root, "checkout", "-q", "-b", "topic")
commit(root, {TS: "export const a = 1;\n"})
git(root, "checkout", "-q", "main")
commit(root, {TSX: "export const b = <div><i /></div>;\n"})
git(root, "checkout", "-q", "topic")
code, out = run(root, "--base", "main")
check("a change landed on the base after the fork is not reported", code == 0 and TSX not in out, out)
check("the comparison is from the fork point", fork[:12] in out, out)

print("files that cannot be comment-only")
root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {"app/src/new.ts": "// c\n"})
code, out = run(root, "--base", base)
check("an added source file is a difference", code == 1 and "app/src/new.ts: added" in out, out)
root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
commit(root, {}, remove=(TS,))
code, out = run(root, "--base", base)
check("a deleted source file is a difference", code == 1 and f"{TS}: deleted" in out, out)
root = make_repo(BASE_FILES)
base = git(root, "rev-parse", "HEAD")
git(root, "mv", TS, "app/src/moved.ts")
git(root, "commit", "-q", "-m", "move")
code, out = run(root, "--base", base)
check("a rename is a delete and an add", code == 1 and f"{TS}: deleted" in out and "app/src/moved.ts: added" in out, out)

print("files outside the lint's scope")
root = make_repo({**BASE_FILES, "docs/a.md": "x\n", "app/src/a.test.ts": "// c\nx();\n"})
base = git(root, "rev-parse", "HEAD")
commit(root, {TS: "export const a = 1;\n", "docs/a.md": "y\n", "app/src/a.test.ts": "x();\n"})
code, out = run(root, "--base", base)
check("they are listed as not checked and do not fail", code == 0 and "not checked" in out and "docs/a.md" in out and "app/src/a.test.ts" in out, out)
root = make_repo({**BASE_FILES, "docs/a.md": "x\n"})
base = git(root, "rev-parse", "HEAD")
commit(root, {"docs/a.md": "y\n"})
code, out = run(root, "--base", base)
check("a diff with no source file is exit 2: it proved nothing", code == 2 and "no source file" in out, out)

print("bad input")
root = make_repo(BASE_FILES)
code, out = run(root, "--base", "no-such-ref")
check("an unknown base is exit 2", code == 2 and "no-such-ref" in out, out)
code, out = run(root, "--base", "HEAD", "--head", "no-such-ref")
check("an unknown head is exit 2", code == 2, out)
code, out = run(Path(tempfile.mkdtemp(prefix="comment-diff-norepo-")), "--base", "HEAD")
check("a root that is no repository is exit 2", code == 2, out)

print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
