---
description: >-
  The routes that grant the engine access to files: allowed folders and files the user picked.
---

# Allowed folders and picked files

## Allowed folders (file roots)

The folders a request-body file may be read from without being picked file by file - one half of the [trust rule](request-body.md#file-references-binary-bodies-and-file-parts), beside the [picked files](#picked-files-file-grants).
Stored in `file_roots` (schema version 3); read once per design send and once per run, so a change applies to the next send.
`POST` and `DELETE` need the [grant secret](index.md#who-may-call-the-api) in `X-Vayu-Grant-Secret` and answer `403` (`grant_secret_required`) without it, before the body is parsed; an engine started without a secret refuses both.
`GET` needs nothing.

### GET /file-roots

Every allowed folder, ordered by path, as a bare array:

```json
[{ "id": "froot_...", "path": "/home/ada/fixtures", "createdAt": 1764000000000 }]
```

### POST /file-roots

Allows a folder.
Body: `{ "path": "/abs/dir" }`.
Create only; the engine owns the id, so a body `id` is a `400`.

- `201` with the row.
  `path` is stored canonical (symlinks resolved, `.` and `..` folded, no trailing separator).
- `400` when `path` is missing, not a string, not absolute, or not an existing directory.
- `400` when the canonical path is a filesystem or drive root (`/`, `C:\`), the user's home folder, or a folder that contains it (`/home`, `/Users`, `C:\Users`), the message naming which: each would allow nearly every file a request could name.
  Containment is by path component, case-folded on a drive letter.
  A folder inside the home folder is fine.
- `409` when the canonical path is already allowed, naming the existing row's id.

### DELETE /file-roots/:id

Stops allowing a folder; the folder and its files are untouched.
`{"success": true}`, or `404` when no such row exists.

## Picked files (file grants)

The files a person picked, each sendable from wherever it lies - the other half of the [trust rule](request-body.md#file-references-binary-bodies-and-file-parts), beside the [allowed folders](#allowed-folders-file-roots) (#2356).
Stored in `file_grants` (schema version 6); read once per design send and once per run, like the folders.
A grant is matched exactly against a reference's canonical path, so it covers that one file and nothing beside it.
`POST` and `DELETE` need the [grant secret](index.md#who-may-call-the-api) in `X-Vayu-Grant-Secret` and answer `403` (`grant_secret_required`) without it, before the body is parsed; an engine started without a secret refuses both.
`GET` needs nothing.

### GET /file-grants

Every picked file, ordered by path, as a bare array:

```json
[{ "id": "fgrant_...", "path": "/home/ada/Downloads/body.bin", "createdAt": 1764000000000 }]
```

### POST /file-grants

Records a picked file.
Body: `{ "path": "/abs/file" }`.
Create only; the engine owns the id, so a body `id` is a `400`.

- `201` with the row.
  `path` is stored canonical (every symlink resolved, `.` and `..` folded), so a link re-pointed after the pick no longer matches.
- `400` when `path` is missing, not a string, empty, holds a `{{variable}}` (a grant names one file, never a template), is not absolute, or is not an existing regular file - a directory, a device or a pipe is never granted.
- `409` when the canonical path is already granted, naming the existing row's id, as a second spelling of an allowed folder is.

### DELETE /file-grants/:id

Forgets a picked file; the file itself is untouched, and a body naming it is refused from then on unless an allowed folder holds it.
`{"success": true}`, or `404` when no such row exists.
