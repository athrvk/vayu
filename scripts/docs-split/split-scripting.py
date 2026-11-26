#!/usr/bin/env python3
"""
Splits docs/engine/scripting.md into the pages of docs/engine/scripting/ (#3854),
re-aims every link to it, and proves the move lost nothing. The machinery and what a
move changes are in docsplit.py; this file holds where the sections go and the new
text (titles, descriptions, the index's table of pages).

Usage: split-scripting.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import sys

from docsplit import Page, Split, main

# A section starts at a marker and runs to the next one. The source's own heading
# tree puts the sandbox notes and the legacy objects under "Worked examples"; the
# pages follow what each section is about.
MARKERS = [
    ("---", "index"),
    ("## The `pm` Object", "test-and-expect"),
    ("## Response Object (`pm.response`)", "response"),
    ("### Reading response headers", "response-headers-and-assertions"),
    ("## Request Object (`pm.request`)", "request"),
    ("### Mutating the request (pre-request scripts)", "request-mutation"),
    ("## Script Identity (`pm.info`)", "info-and-setup"),
    ("## Environment Variables (`pm.environment`)", "variables"),
    ("## Sending a request from a script (`pm.sendRequest`)", "send-request"),
    ("## The cookie jar (`pm.cookies`)", "cookies"),
    ("## Flow control (`pm.execution`)", "execution-metrics-data"),
    ("## Console Output", "console-and-examples"),
    ("### Isolation between scripts", "sandbox"),
    ("### The `require` shelf", "require-shelf"),
    ("### Timers (`setTimeout` and `setInterval`)", "sandbox"),
    ("### The legacy `postman` object", "legacy-and-visualizer"),
    ("## What the editor offers, and where it comes from", "limitations"),
    ("## Script Execution Context", "execution-context"),
    ("## Error Handling", "errors-and-practices"),
]

PAGES = {
    "index": Page(None, None),
    "test-and-expect": Page(
        None,
        "`pm.test()` and `pm.expect()`: how a test is declared and reported, and every assertion "
        "the Chai-style `expect` offers.",
        ("`pm.test()`, `pm.expect()`",),
    ),
    "response": Page(
        None,
        "`pm.response`: status and code, the events of a streamed run, an mcp reply's failure class "
        "and the redirects a send followed.",
        ("`pm.response`: status, events, mcp, redirects",),
    ),
    "response-headers-and-assertions": Page(
        "Response headers, cookies and assertions",
        "Reading response headers and cookies from `pm.response`, and the assertions written against "
        "a response.",
        ("`pm.response` headers, cookies and assertions",),
    ),
    "request": Page(
        None,
        "`pm.request`: what a script reads from the request, including GraphQL and string bodies.",
        ("`pm.request`: reading the request",),
    ),
    "request-mutation": Page(
        "Mutating the request",
        "How a pre-request script changes the request: header methods, request methods, URL parts and "
        "the rules each follows.",
        ("`pm.request.headers`, `pm.request.addHeader`, `pm.request.url`",),
    ),
    "info-and-setup": Page(
        "Script identity, setup and teardown",
        "`pm.info` and the setup and teardown scripts: who a script is told it is and when each kind runs.",
        ("`pm.info`, setup and teardown scripts",),
    ),
    "variables": Page(
        "Variables and environments",
        "The variable scopes a script reaches: `pm.environment`, collection and global variables, and "
        "`pm.variables`.",
        ("`pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`",),
    ),
    "send-request": Page(
        None,
        "`pm.sendRequest`: sending a request from a script, its options, its result and its limits.",
        ("`pm.sendRequest`",),
    ),
    "cookies": Page(
        None,
        "`pm.cookies` and the cookie jar: reading cookies and writing to the jar.",
        ("`pm.cookies`, `pm.cookies.jar()`",),
    ),
    "execution-metrics-data": Page(
        "Flow control, metrics and data rows",
        "`pm.execution` flow control, `pm.metrics` custom metrics and `pm.iterationData` data rows.",
        ("`pm.execution`, `pm.metrics`, `pm.iterationData`",),
    ),
    "console-and-examples": Page(
        "Console output and examples",
        "What `console` prints and where, and worked examples of tests and of pre-request scripts that "
        "rewrite a request.",
        ("`console`, examples, worked request rewrites",),
    ),
    "sandbox": Page(
        "The sandbox",
        "What the QuickJS sandbox gives a script: isolation between scripts, what a script can compute, "
        "timers and top-level await.",
        ("Isolation, compute, timers, top-level `await`",),
    ),
    "require-shelf": Page(
        None,
        "The modules a script can `require`, and what each provides.",
        ("`require`",),
    ),
    "legacy-and-visualizer": Page(
        "Legacy postman objects and the visualizer",
        "The legacy `postman` object, Postman's legacy globals and `pm.visualizer`.",
        ("`postman`, legacy globals, `pm.visualizer`",),
    ),
    "limitations": Page(
        "Editor support and limitations",
        "What the script editor offers and where it comes from, and what a script cannot do.",
        ("The script editor, limitations",),
    ),
    "execution-context": Page(
        "Where each kind of script runs",
        "When each kind of script runs - pre-request, test, load test and script elements - and what "
        "each can see.",
        ("Pre-request, test and load test scripts, script elements",),
    ),
    "errors-and-practices": Page(
        "Errors, best practices and the API reference",
        "How script errors are reported, practices for writing scripts and where the API reference lives.",
        ("Error handling, best practices",),
    ),
}

SPLIT = Split(
    source="docs/engine/scripting.md",
    markers=MARKERS,
    pages=PAGES,
    table_columns=("Covers",),
    table_intro="Each page holds one `pm.*` area or one part of the sandbox.",
    table_before="## Quick Start",
    prog="split-scripting",
    label_prefix=r"(?:docs/)?(?:engine/)?",
)

if __name__ == "__main__":
    sys.exit(main(SPLIT))
