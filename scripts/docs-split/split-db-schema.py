#!/usr/bin/env python3
"""
Splits docs/engine/db-schema.md into the pages of docs/engine/db-schema/ (#3854),
re-aims every link to it, and proves the move lost nothing. The machinery and what a
move changes are in docsplit.py; this file holds where the sections go and the new
text (titles, descriptions, the index's table of pages).

Usage: split-db-schema.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import sys

from docsplit import Page, Split, main

# A section starts at a marker and runs to the next one. The tables keep their
# source order, so a page that holds two groups (environments, then globals) has
# the one that came first in the source first.
MARKERS = [
    ("---", "index"),
    ("## Startup validation, backup and recovery", "startup-and-recovery"),
    ("### Schema versions", "schema-versions"),
    ("## Connection settings", "index"),
    ("## Tables", "index"),
    ("### `collections`", "collections-and-requests"),
    ("### `spec_documents`", "specs"),
    ("### `environments`", "environments-and-globals"),
    ("### `client_certificates`", "credentials-and-files"),
    ("### `globals`", "environments-and-globals"),
    ("### `runs`", "runs"),
    ("### `oauth_tokens`", "credentials-and-files"),
    ("### `metric_ticks`", "run-artifacts"),
    ("### `config_entries`", "config"),
    ("## Indexes", "indexes"),
]

PAGES = {
    "index": Page(None, None),
    "startup-and-recovery": Page(
        None,
        "How the engine validates, backs up and repairs its database at startup: the copy before a "
        "migration, the quarantine, the recovery marker and each repair pass.",
        ("Startup validation, the copy before a migration, the quarantine, the recovery marker, "
         "reclaiming freed pages and each repair or migration pass",),
    ),
    "schema-versions": Page(
        None,
        "`SCHEMA_VERSION`: when a change bumps it, why a bump is one-way and the change each version "
        "stands for.",
        ("`SCHEMA_VERSION`, when a change bumps it and what each version changed",),
    ),
    "collections-and-requests": Page(
        "Collections, requests and request examples",
        "The tables that hold the saved tree: collections, requests and a request's saved examples.",
        ("`collections`, `requests`, `request_examples`",),
    ),
    "specs": Page(
        "Spec documents",
        "The tables that hold a collection's API specification and the operations a user declined to "
        "import from it.",
        ("`spec_documents`, `spec_declined_operations`",),
    ),
    "environments-and-globals": Page(
        "Environments and globals",
        "The tables that hold environments and the global variables.",
        ("`environments`, `globals`",),
    ),
    "credentials-and-files": Page(
        "Certificates, file access and OAuth tokens",
        "The tables that hold client certificates, the folders and files the engine may read, and the "
        "cached OAuth tokens.",
        ("`client_certificates`, `file_roots`, `file_grants`, `oauth_tokens`",),
    ),
    "runs": Page(
        "The runs table",
        "The `runs` table: one row per execution and everything a run records about itself.",
        ("`runs`",),
    ),
    "run-artifacts": Page(
        "Run samples, results and the inbox",
        "The tables a run writes as it goes: metric ticks, monitor samples, results, stored bodies and "
        "the webhook inbox.",
        ("`metric_ticks`, `monitor_samples`, `results`, `result_bodies`, `body_blobs`, `inbox_requests`",),
    ),
    "config": Page(
        "The config_entries table",
        "The `config_entries` table: every tunable setting the engine persists, with its UI metadata.",
        ("`config_entries`",),
    ),
    "indexes": Page(
        "Indexes and the VariableValue shape",
        "The indexes the engine creates and the JSON shape a stored variable value takes.",
        ("Every index, the `VariableValue` JSON shape",),
    ),
}

SPLIT = Split(
    source="docs/engine/db-schema.md",
    markers=MARKERS,
    pages=PAGES,
    table_columns=("Holds",),
    table_intro="Each page holds one group of tables.",
    table_before="## Connection settings",
    prog="split-db-schema",
)

if __name__ == "__main__":
    sys.exit(main(SPLIT))
