---
description: >-
  The environment variables the stdio MCP CLI reads, and what a mistyped one does.
---

# MCP configuration

## Configuration

The Electron-hosted server reads config from Settings.
The **stdio CLI** reads it from environment variables:

| Variable                        | Default                 | Meaning                                |
| ------------------------------- | ----------------------- | -------------------------------------- |
| `VAYU_ENGINE_URL`               | `http://127.0.0.1:9876` | Engine base URL. Set it to the address the Dock shows when the app fell back to another port (#2118); the Electron-hosted server follows the app's port by itself. |
| `VAYU_VERSION`                  | `0.0.0`                 | Version reported to clients.           |
| `VAYU_MCP_ALLOWLIST`            | (empty)                 | Comma-separated hostnames.             |
| `VAYU_MCP_ALLOW_ALL`            | `false`                 | `true` bypasses the allowlist.         |
| `VAYU_MCP_MAX_RPS`              | `1000`                  | RPS cap.                               |
| `VAYU_MCP_MAX_CONCURRENCY`      | `200`                   | Virtual-user cap.                      |
| `VAYU_MCP_MAX_DURATION_SECONDS` | `300`                   | Duration cap.                          |
| `VAYU_MCP_MAX_ITERATIONS`       | `10000`                 | Iterations cap (iterations mode).      |
| `VAYU_MCP_MAX_RESPONSE_SAMPLES` | `10000`                 | Cap on `maxResponseSamples`, the responses kept for the sampled replay. |
| `VAYU_MCP_ALLOW_WRITES`         | `false`                 | `true` enables the data-write tools.   |
| `VAYU_MCP_ALLOW_NETWORK_SETTINGS` | `false`               | `true` opens the proxy and CA config keys to writes. |
| `VAYU_MCP_REVEAL_SECRETS`       | `false`                 | `true` lifts the secret withholding (reads, write answers, run output). |
| `VAYU_MCP_DISABLED_TOOLS`       | (empty)                 | Comma-separated tool names to disable. |
| `VAYU_LOG_DIR`                  | (unset)                 | Also write `mcp_<stamp>.log` there (#1558). |

**What a refusal names in a CLI session** (#2439).
Each refusal tells the user how to lift it for the host serving the session (`remedy.ts`); the CLI's sentence is "set `VAR=true` in the environment of the MCP server and restart it", and the config is fixed for the process, so a restart is part of every one.

| Refusal                                              | Names, in the CLI                       | Names, in the app                    |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------ |
| Host not on the allowlist (or the list is empty)     | `VAYU_MCP_ALLOWLIST`                    | Settings → MCP, Target allowlist     |
| `targetRps`, virtual users, duration, iterations, response samples cap | the matching `VAYU_MCP_MAX_*`           | Settings → MCP, the cap's field      |
| Writes disabled (data writes and engine config)      | `VAYU_MCP_ALLOW_WRITES`                 | Settings → MCP, Write access         |
| Proxy or CA config key without the network gate      | `VAYU_MCP_ALLOW_NETWORK_SETTINGS`       | Settings → MCP, Network settings     |
| Script, or `secret: false`, while reveal is off      | `VAYU_MCP_REVEAL_SECRETS`               | Settings → MCP, Reveal secrets       |
| A tool switched off                                  | `VAYU_MCP_DISABLED_TOOLS`               | Settings → MCP, Tools                |
| Engine unreachable                                   | start `vayu-engine`, or `VAYU_ENGINE_URL` | the app is open but its engine is not answering: wait, or Settings → Restart engine |
| `verifySSL: false` on a one-off send                 | add the authority to the engine's `customCaCertificates` through `update_engine_config`, which needs `VAYU_MCP_ALLOW_WRITES` and `VAYU_MCP_ALLOW_NETWORK_SETTINGS` | Settings > Network & connectivity |
| A `binary` body's file path                          | no setting: the stdio server has no request editor to pick a file in and nothing that allows a folder, so only a folder the engine already allows works | the request editor, or Settings > Files |
| A collection's remembered data file (`dataFile`)     | never present: `dataFileLocation` is absent on stdio, so no path is remembered; ask the user for it | the app remembers the path |
| What `sync_spec`'s safe policy declined              | no setting: a person ticks it under Collection -> Spec -> Sync in the desktop app | Collection -> Spec -> Sync |

The server instructions' write and reveal gate sentences read the host the same way, and so do the tool, resource and prompt descriptions.
A description is built at module load or, for a tool whose wording depends on the session (the withholding pointer, #2441), from the config at registration;
either way it does not know the host, so it names its remedy with a token from `remedy.ts` (`GUARDED_WRITE_SENTENCE` opens each of the write tools' gates, `REVEAL_SETTING_TOKEN` ends each withheld-output sentence in `withhold.ts`, and the Files, authority, data-file, proxy and Sync remedies above have one each).
`server.ts` fills the tokens in per session: the whole `tools/list` answer (a tool's description, its parameters' descriptions and its output schema) and each resource's description.
`toolCatalog()`, which feeds the app's Settings tool list, always resolves for `app`, and `dispatchTool` resolves a token in a refusal's text (`INLINE_FILE_REFUSAL`, `INSECURE_TLS_REFUSAL`).
Only tokens `remedy.ts` defines are replaced, so braces in a user's own text pass through.
`remedy.test.ts` iterates `SAFETY_ENV_VARS`, so a safety field added without a variable fails there, and `server-host.test.ts` drives each refusal through the real dispatch for both hosts and asserts a CLI message never says "Settings" or "Vayu app".
It also lists every tool (parameter descriptions included), resource and prompt for a CLI session with writes on and off and fails on either phrase, or on a token left unresolved, naming the tool.

Both entry points sanitize their input through the same function (`sanitizeSafetyInput` in `electron/mcp/config.ts`), so the environment is held to exactly the rules Settings is held to:

- **A malformed cap falls back to its default, never to "no cap".**
  `VAYU_MCP_MAX_RPS="1,000"` is not a number, so the `1000` default applies and still refuses an over-cap run.
  The CLI names what it dropped on stderr: `[vayu-mcp] ignoring malformed VAYU_MCP_MAX_RPS="1,000" (using default 1000)`.
  Non-positive values (`0`, `-5`) are treated the same way; fractional values are floored.
- **A cap above its ceiling is named too, through its own channel.**
  It did not fall back - it is in force, held at the ceiling - so the CLI says which value actually applies rather than which default did: `[vayu-mcp] VAYU_MCP_MAX_CONCURRENCY="50000" is above the maximum of 10000; running with 10000`.
  Without it the operator believes the policy is 50000 and learns otherwise from a refused run.
  Flooring alone is not reported: `999.7` becomes `999` and names no maximum, because it came near none.
- **Allowlist entries are reduced to a bare hostname**, so `https://api.example.com` and `api.example.com:8080` both match the `api.example.com` the guard compares against.
  Entries are de-duplicated.
- The two opt-in booleans stay off for any value other than the exact string `true`.
