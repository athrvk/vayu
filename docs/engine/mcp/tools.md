---
description: >-
  Every tool the Vayu MCP server registers, with its category and annotation hints, generated from the tool registry.
---

# MCP tools

<!-- Generated from the TOOLS registry (app/electron/mcp/tools/*.tools.ts) by
app/electron/mcp/tools-doc.testkit.ts. Do not edit: run `pnpm docs:mcp-tools` from app/. -->

**84 tools, 9 resources, 4 prompts.**

One row per tool, sorted by name.
The category decides which gate applies ([Tool conventions](conventions.md)).
The hints are the MCP annotations the server declares for the tool.
What a tool does and takes is its own description, which a client reads from `tools/list`;
the notes on each family of tools are linked from [the overview](index.md).

| Tool | Category | Title | Hints |
| ---- | -------- | ----- | ----- |
| `activate_environment` | write | Activate environment | idempotent |
| `bind_spec` | write | Bind OpenAPI spec | - |
| `clear_cookies` | write | Clear cookie jars | destructive, idempotent |
| `clear_inbox_captures` | write | Clear inbox captures | destructive, idempotent |
| `clear_oauth2_token` | write | Clear OAuth 2.0 token | destructive, idempotent |
| `compare_runs` | read | Compare runs | read-only, idempotent |
| `create_collection` | write | Create collection | - |
| `create_environment` | write | Create environment | - |
| `create_request` | write | Create saved request | - |
| `create_request_example` | write | Create saved example | - |
| `delete_collection` | write | Delete collection | destructive, idempotent |
| `delete_environment` | write | Delete environment | destructive, idempotent |
| `delete_request` | write | Delete saved request | destructive, idempotent |
| `delete_request_example` | write | Delete saved example | destructive, idempotent |
| `delete_run` | write | Delete run | destructive, idempotent |
| `delete_webhook_inbox` | write | Delete webhook inbox | destructive, idempotent |
| `diagnose_connection` | execute | Diagnose a connection | read-only, idempotent, open-world |
| `diff_bodies` | read | Compare two stored bodies | read-only, idempotent |
| `diff_spec` | read | Diff OpenAPI spec against collection | read-only, idempotent |
| `export_postman` | read | Export collection as Postman | read-only, idempotent |
| `export_run_report` | read | Export run report | read-only, idempotent |
| `export_spec` | read | Export collection as OpenAPI | read-only, idempotent |
| `fetch_oauth2_token` | execute | Fetch OAuth 2.0 token | destructive, open-world |
| `get_app_focus` | read | Get the app's open tab and environment | read-only, idempotent |
| `get_cookies` | read | Get cookie jars | read-only, idempotent |
| `get_engine_config` | read | Get engine config | read-only, idempotent |
| `get_engine_health` | read | Check engine health | read-only, idempotent |
| `get_globals` | read | Get global variables | read-only, idempotent |
| `get_graphql_schema` | read | Get a GraphQL request's schema | read-only, idempotent, open-world |
| `get_inbox_captures` | read | Get inbox captures | read-only |
| `get_live_metrics` | read | Get live metrics | read-only |
| `get_mock_activity` | read | Get mock server activity | read-only |
| `get_mock_routes` | read | Get mock server routes | read-only, idempotent |
| `get_oauth2_token_status` | read | OAuth 2.0 token status | read-only, idempotent |
| `get_request` | read | Get a request | read-only, idempotent |
| `get_run` | read | Get run status | read-only, idempotent |
| `get_run_monitor` | read | Get run monitor series | read-only, idempotent |
| `get_run_report` | read | Get run report | read-only, idempotent |
| `get_run_samples` | read | Get run samples | read-only, idempotent |
| `get_run_timeseries` | read | Get run time series | read-only, idempotent |
| `get_safety_config` | read | Get the safety limits | read-only, idempotent |
| `get_script_api` | read | Get the script API | read-only, idempotent |
| `get_spec` | read | Get bound OpenAPI spec | read-only, idempotent |
| `import_document` | write | Import a document | - |
| `list_client_certificates` | read | List client certificates | read-only, idempotent |
| `list_collections` | read | List collections | read-only, idempotent |
| `list_element_kinds` | read | List element kinds | read-only, idempotent |
| `list_environments` | read | List environments | read-only, idempotent |
| `list_mock_issuers` | read | List mock OAuth issuers | read-only, idempotent |
| `list_mock_servers` | read | List mock servers | read-only, idempotent |
| `list_request_examples` | read | List saved examples | read-only |
| `list_requests` | read | List requests | read-only, idempotent |
| `list_runs` | read | List runs | read-only, idempotent |
| `list_trash` | read | List trash | read-only, idempotent |
| `list_webhook_inboxes` | read | List webhook inboxes | read-only, idempotent |
| `move_item` | write | Move an item | idempotent |
| `preview_import` | read | Preview an import | read-only, idempotent |
| `preview_spec_bind` | read | Preview an OpenAPI bind | read-only, idempotent |
| `purge_trash_entry` | write | Purge from Trash | destructive, idempotent |
| `read_body` | read | Read a stored body | read-only, idempotent |
| `resolve_variables` | read | Resolve variables | read-only, idempotent |
| `restore_trash_entry` | write | Restore from Trash | idempotent |
| `run_collection` | execute | Run collection | destructive, open-world |
| `run_collection_smoke` | execute | Run collection smoke test | destructive, open-world |
| `run_request` | execute | Send a request | destructive, open-world |
| `set_run_baseline` | write | Pin run as baseline | idempotent |
| `start_load_run` | load | Start load test | destructive, open-world |
| `start_mock_issuer` | execute | Start mock OAuth issuer | - |
| `start_mock_server` | execute | Start mock server | - |
| `start_webhook_inbox` | execute | Start webhook inbox | - |
| `stop_mock_issuer` | execute | Stop mock OAuth issuer | idempotent |
| `stop_mock_server` | execute | Stop mock server | idempotent |
| `stop_run` | load | Stop run | idempotent |
| `stop_webhook_inbox` | execute | Stop webhook inbox | idempotent |
| `sync_spec` | write | Apply OpenAPI spec drift | - |
| `unbind_spec` | write | Unbind OpenAPI spec | idempotent |
| `update_collection` | write | Update collection | idempotent |
| `update_engine_config` | write | Update engine config | destructive, idempotent |
| `update_environment` | write | Update environment | destructive |
| `update_globals` | write | Update global variables | destructive |
| `update_inbox_response` | execute | Update inbox response | idempotent |
| `update_mock_issuer` | execute | Update mock OAuth issuer | idempotent |
| `update_request` | write | Update saved request | idempotent |
| `update_request_example` | write | Update saved example | idempotent |
