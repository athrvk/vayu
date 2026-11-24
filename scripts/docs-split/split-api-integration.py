#!/usr/bin/env python3
"""
Splits docs/app/api-integration.md into the pages of docs/app/api-integration/
(#3854), re-aims every link to it, and proves the move lost nothing. The machinery
and what a move changes are in docsplit.py; this file holds where the sections go
and the new text (titles, descriptions, the index's table of pages).

Usage: split-api-integration.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import sys

from docsplit import Page, Split, main

# A section starts at a marker and runs to the next one.
MARKERS = [
    ("---", "index"),
    ("## HTTP Client (`services/http-client.ts`)", "http-client-and-service"),
    ("### API Methods", "methods-local"),
    ("#### Request examples", "methods-saved"),
    ("#### Webhook inbox", "methods-local"),
    ("#### Create vs update", "methods-saved"),
    ("#### Specs", "methods-specs"),
    ("#### Requests", "methods-saved"),
    ("#### Environments", "methods-environments-import"),
    ("#### Execution", "methods-execution"),
    ("#### Scripting", "methods-oauth-scripting"),
    ("## SSE Client (`services/sse-client.ts`)", "sse-client"),
    ("## API Endpoints (`config/api-endpoints.ts`)", "endpoints"),
    ("## Request Execution Flow", "execution-flow"),
    ("### Streaming Request Execution (issue #574)", "streaming"),
    ("### Load Test Execution", "execution-flow"),
    ("## Error Handling", "errors-and-connection"),
    ("## Best Practices", "testing-and-troubleshooting"),
]

PAGES = {
    "index": Page(None, None),
    "http-client-and-service": Page(
        "HTTP client and API service",
        "The renderer's HTTP client and the API service over it: errors, the snake_case to camelCase "
        "transformation and the request-body shapes.",
        ("`services/http-client.ts`, `services/api.ts`, data transformation",),
    ),
    "methods-local": Page(
        "API methods: configuration and local services",
        "The API service's methods for health and configuration, the cookie jar, allowed folders, the "
        "webhook inbox, the mock issuer and the collection mock server.",
        ("Health and configuration, cookie jar, allowed folders, webhook inbox, OAuth 2.0 mock issuer, "
         "collection mock server",),
    ),
    "methods-saved": Page(
        "API methods: collections, requests and examples",
        "The API service's methods for saved data: request examples, the create-versus-update rule, "
        "collections, requests, the trash and reordering.",
        ("Request examples, create vs update, collections, requests, trash, reorder",),
    ),
    "methods-specs": Page(
        "API methods: specs",
        "The API service's methods for stored API specs: store, match, diff, bind, export and sync.",
        ("Specs",),
    ),
    "methods-environments-import": Page(
        "API methods: environments, globals and import",
        "The API service's methods for environments, global variables and importing a document.",
        ("Environments, global variables, import",),
    ),
    "methods-execution": Page(
        "API methods: execution and runs",
        "The API service's methods for sending a request, starting a run and managing runs.",
        ("Execution, run management",),
    ),
    "methods-oauth-scripting": Page(
        "API methods: OAuth 2.0 and scripting",
        "The API service's methods for the OAuth 2.0 token cache and flow, and for the scripting "
        "completions the editor reads.",
        ("OAuth 2.0, scripting",),
    ),
    "sse-client": Page(
        None,
        "The SSE client for a run's live stream: its features, usage and the event types it delivers.",
        ("`services/sse-client.ts`",),
    ),
    "endpoints": Page(
        None,
        "The centralized endpoint configuration the HTTP client and the SSE client read.",
        ("`config/api-endpoints.ts`",),
    ),
    "execution-flow": Page(
        None,
        "How a single request and a load test travel from the user's click to the engine and back.",
        ("Single request execution, load test execution",),
    ),
    "streaming": Page(
        None,
        "How a request with the Event stream setting travels: the shared composition, the 202 answer, "
        "the live events and how a stopped or failed stream ends.",
        ("Streaming request execution",),
    ),
    "errors-and-connection": Page(
        "Errors and connection management",
        "How the app handles HTTP, network and SSE errors, checks the engine's health and starts the "
        "engine.",
        ("Error handling, health checking, engine startup",),
    ),
    "testing-and-troubleshooting": Page(
        "Best practices, testing and troubleshooting",
        "Practices for code that calls the engine, how to mock the API in tests, and what to check "
        "when the engine or SSE does not respond.",
        ("Best practices, mocking, troubleshooting",),
    ),
}

SPLIT = Split(
    source="docs/app/api-integration.md",
    markers=MARKERS,
    pages=PAGES,
    table_columns=("Covers",),
    table_intro="Each page holds one part of the integration.",
    table_before="## Overview",
    prog="split-api-integration",
)

if __name__ == "__main__":
    sys.exit(main(SPLIT))
