---
description: >-
  `SCHEMA_VERSION`: when a change bumps it, why a bump is one-way and the change each version stands for.
---

# Schema versions

`SCHEMA_VERSION` lives in `engine/include/vayu/db/database.hpp`.
It is bumped by the commit that changes `make_vayu_storage`'s mapping - an added column included - because `sync_schema ()` runs without `preserve`: an older engine opening a database with a column it does not map would rebuild that table without it.
It is also bumped by a migration step that must run exactly once and that an older engine must not read past (versions `4`, `6` and `7`); the version is that step's done-marker.
**A bump is one-way.**
Once a newer engine has opened a workspace, every engine that carries the version gate refuses it at startup (the refusal above), so the release that carries a bump says so in its notes.
The way back is the [copy before a migration](startup-and-recovery.md#the-copy-before-a-migration): install the older release, then restore `backups/vayu-<stamp>-pre-v<N>.db` as [architecture.md](../architecture.md#restoring) describes; anything written since the update is not in it.
The gate first shipped in `0.27.0`: `0.26.0` and earlier have none, and opening a newer workspace with one rebuilds `requests` and `collections` empty (their `pre_request_script` / `post_request_script` columns are `NOT NULL` with no default, which sqlite_orm cannot add to an existing table) and then copies that emptied file over `<db>.bak`, with no error.
A shipped binary cannot be changed, so nothing in the engine can stop that.
`install.sh` refuses to install a version below `0.27.0` over an existing `db/vayu.db` unless given `--allow-data-loss`.
The Windows installer and `winget` cannot gate an install: a check added to a newer installer does not exist in the older installer being run, and `winget` runs the vendor installer of whichever version is pinned.
On Windows the only protection is not installing an older version over a newer workspace; restore a Workspace backup first if you must.

| Version | Change | Migration step |
|---------|--------|----------------|
| `0` | Every database before #1514 (never stamped) | - |
| `1` | Scripts folded into `elements`; `pre_request_script` / `post_request_script` dropped (#1514) | the fold above |
| `2` | `request_examples.postman_response` added (the Postman saved response an example was imported from); `requests.disable_cookies`, `disabled_system_headers`, `disable_url_encoding` and `postman_protocol_behavior` added (#1765) | none: `sync_schema ()` adds the nullable and defaulted columns, the migration only stamps |
| `3` | [`file_roots`](credentials-and-files.md#file_roots) added - the folders request-body files may be read from. Also the fence for the `binary` body's `file` reference: an engine at `2` would send such a body bodiless | none: `sync_schema ()` creates the table, the migration only stamps |
| `4` | No mapping change. Every stored body's file references state `unresolved`, and the allowed folders that are a filesystem root, the home folder or a folder containing it are removed. An engine at `3` read an absent key as chosen | [the file-trust restatement](startup-and-recovery.md#the-file-trust-restatement-schema-version-4) |
| `5` | `oauth_tokens.raw_response` dropped (#1781): the provider response, refresh and id tokens included, was stored and never read; [`runs.origin` and `runs.origin_client`](runs.md#runs) added (#1817) | none: `sync_schema ()` drops the one column at the constructor's probe and adds the defaulted and nullable two, the migration only stamps |
| `6` | [`file_grants`](credentials-and-files.md#file_grants) added - the files a person picked (#2356). Every stored file reference loses `unresolved`; the ones stored as chosen become grants. An engine at `5` would read the missing key as untrusted and refuse every picked file | [the file-grants migration](startup-and-recovery.md#the-file-grants-migration-schema-version-6) |
| `7` | No mapping change. A collection's sub-folders and requests share one `order` space (#2535); every request moves past its collection's sub-folders so the display is unchanged. An engine at `6` would number the two kinds apart again on its next create or reorder | [the sibling-order migration](startup-and-recovery.md#the-sibling-order-migration-schema-version-7) |
| `8` | [`collections.spec_file` and `data_file`](collections-and-requests.md#collections) added (#2765): the files a collection's Spec and Data tabs are bound to, so a backup carries them | none: `sync_schema ()` adds both defaulted columns, the migration only stamps |
| `9` | [`requests.timeout_ms`](collections-and-requests.md#requests) added (#2937): a request's own timeout, NULL for the `defaultTimeout` setting; [`environments.deleted_at`](environments-and-globals.md#environments) added (#2970): the environment trash; [`request_examples.deleted_at`](collections-and-requests.md#request_examples) added (#2971): the example trash; [`client_certificates.deleted_at`](credentials-and-files.md#client_certificates) added (#2973): the certificate trash; [`idx_requests_deleted_at`](indexes.md#indexes) added (#3006): a partial index on the stamped requests | none: `sync_schema ()` adds the nullable columns and creates the index, the migration only stamps |
| `10` | [`spec_declined_operations`](specs.md#spec_declined_operations) added (#3031): the operations a person declined by deleting the request for them, so a sync does not re-create them. An engine at `9` does not know the table, so it would re-create every declined operation on its next sync | none: `sync_schema ()` creates the table, the migration only stamps |
| `11` | [`runs.outcome`](runs.md#runs) added (#3547): the verdict a run's list row draws, so `GET /runs` can filter on it. An engine at `10` would rebuild `runs` without the column. [`requests.stream_text_path`](collections-and-requests.md#requests) and [`result_bodies.stream_text_path`](run-artifacts.md#result_bodies) added (#3773): a stream's declared text path, on the request and on each captured sample. [`requests.stream_first_content_marker`](collections-and-requests.md#requests) added (#3774): the literal a run times its stream to | none: `sync_schema ()` adds the nullable columns, the migration only stamps; rows stored before them stay NULL |

The #1765 columns joined version `2` rather than bumping to `3` because no released build has ever stamped `2`: the version shipped only on the unreleased branch that carried both changes.
`sync_schema ()` runs on every start whatever the stamp, so a development database an earlier build of that branch already stamped `2` still gets the four columns.
**Merge gate:** before this merges, run `git grep "SCHEMA_VERSION\s*=" $(git describe --tags --abbrev=0)`; if the last tag already shows `2` (the `postman_response` change was released on its own), the #1765 columns need their own bump to `3` and a row of their own here.

The #1817 `runs` columns joined version `5` the same way: `0.40.0`, the last release, stamps `4`, so no released build has stamped `5`.
**Merge gate:** the same `git grep` against the last tag must still show `4`; if a release shipped `5` without these columns, they need their own bump to `6`.
The release notes of the release that carries version `5` say so under Changed (one-way: every earlier engine refuses the workspace), naming both #1781 and #1817.

Version `6` is a bump of its own: `0.41.0` released `5`, and every release since stamps it.
**Merge gate:** the `git grep` against the last tag must show `5`; a column that joins `6` later must check the tag the same way.
The release that carries `6` says so under Changed, naming #2356.

Version `7` is a bump of its own even though no release stamps `6`: joining an unreleased version works for what `sync_schema ()` redoes on every start, and the sibling-order shift is a one-time rewrite of stored rows.
A development database an unreleased build already stamped `6` must still run it, and would skip it at `6`.
The release that carries `7` says so under Changed, naming #2535.

Version `8` is a bump of its own: `0.45.0` released `7`.
**Merge gate:** the `git grep` against the last tag must show `7`; a column that joins `8` later must check the tag the same way.
The release that carries `8` says so under Changed, naming #2765.

Version `9` is a bump of its own even though no release stamps `8`: an engine built between #2765 and #2937 stamps `8` too, and its `sync_schema ()` would drop `timeout_ms`, and every request's timeout with it, from a workspace a newer build had opened; at `9` it refuses the workspace instead.
**Merge gate:** the `git grep` against the last tag must show `7` or `8`; a column that joins `9` later must check the tag the same way.
The release that carries `9` says so under Changed, naming #2937.

The #2970 `environments.deleted_at` column joined version `9` the same way the #1817 columns joined `5`: `0.45.0`, the last release, stamps `7`, so no released build has stamped `9`, and `sync_schema ()` adds the nullable column on every start whatever the stamp.
**Merge gate:** the `git grep` against the last tag must still show `7` or `8`; if a release shipped `9` without this column, it needs its own bump to `10` and a row of its own here.
The release that carries `9` names #2970 beside #2937 under Changed.

The #2971 `request_examples.deleted_at` column joined version `9` by the same argument and under the same gate: the last release still stamps `7`, and `sync_schema ()` adds the nullable column on every start whatever the stamp.
If a release shipped `9` without it, it needs its own bump and its own row here.
The release that carries `9` names #2971 beside #2970 and #2937 under Changed.

The #2973 `client_certificates.deleted_at` column joined version `9` by the same argument and under the same gate: the last release still stamps `7`, and `sync_schema ()` adds the nullable column on every start whatever the stamp.
If a release shipped `9` without it, it needs its own bump and its own row here.
The release that carries `9` names #2973 beside #2971, #2970 and #2937 under Changed.

The #3006 index `idx_requests_deleted_at` joined version `9` under the same gate: any change to `make_vayu_storage`'s mapping bumps the version, an index included, and `sync_schema ()` creates it on every start whatever the stamp, so a database an earlier build of this branch stamped `9` still gets it.
If a release shipped `9` without it, it needs its own bump and its own row here.
The release that carries `9` names #3006 beside #2971, #2970 and #2937 under Changed.

Version `10` is a bump of its own: `0.46.0` released `9`.
**Merge gate:** the `git grep` against the last tag must show `9`; a change that joins `10` later must check the tag the same way.
The release that carries `10` says so under Changed, naming #3031.

Version `11` is a bump of its own: `0.51.1`, the last release, stamps `10`.
**Merge gate:** the `git grep` against the last tag must show `10`; a change that joins `11` later must check the tag the same way.
The release that carries `11` says so under Changed, naming #3547.

The two #3773 `stream_text_path` columns and the #3774 `requests.stream_first_content_marker` column joined version `11` the way the #1817 columns joined `5`: `0.51.1`, the last release, stamps `10`, so no released build has stamped `11`, and `sync_schema ()` adds the nullable columns on every start whatever the stamp, so a database an earlier build of `11` stamped still gets them.
**Merge gate:** the `git grep` against the last tag must still show `10`; if a release shipped `11` without these columns, they need their own bump to `12` and a row of their own here.
The release that carries `11` names #3773 and #3774 beside #3547 under Changed.
