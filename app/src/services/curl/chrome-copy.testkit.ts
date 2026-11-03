/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One request as Chrome's "Copy as cURL" writes it, in both flavours.
 *
 * Shared by `tokenize.test.ts` (both copies tokenize to the same argv) and
 * `parseCurl.test.ts` (both import as the same request), so the two layers are
 * held to one fixture rather than two that could drift.
 */

/** "Copy as cURL (cmd)": every argument `^"..."` quoted, `^` guarding metacharacters. */
export const chromeCmdCopy = [
	String.raw`curl ^"https://api.example.com/v1/users?x=1^&y=2^" ^`,
	String.raw`  -H ^"accept: application/json^" ^`,
	String.raw`  -H ^"content-type: application/json^" ^`,
	String.raw`  -b ^"session=abc^%^3D^" ^`,
	String.raw`  --data-raw ^"^{^\^"name^\^":^\^"Ada Lovelace^\^",^\^"tags^\^":^[^\^"a^\^",^\^"b^\^"^],^\^"path^\^":^\^"C:^\^\^\^\tmp^\^",^\^"rate^\^":^\^"5^%^\^"^}^" ^`,
	String.raw`  --compressed`,
].join("\n");

/** "Copy as cURL (bash)": the same request, POSIX single-quoted. */
export const chromeBashCopy = [
	`curl 'https://api.example.com/v1/users?x=1&y=2' \\`,
	`  -H 'accept: application/json' \\`,
	`  -H 'content-type: application/json' \\`,
	`  -b 'session=abc%3D' \\`,
	`  --data-raw '{"name":"Ada Lovelace","tags":["a","b"],"path":"C:\\\\tmp","rate":"5%"}' \\`,
	`  --compressed`,
].join("\n");

/** What both copies tokenize to. */
export const chromeCopyArgv = [
	"curl",
	"https://api.example.com/v1/users?x=1&y=2",
	"-H",
	"accept: application/json",
	"-H",
	"content-type: application/json",
	"-b",
	"session=abc%3D",
	"--data-raw",
	String.raw`{"name":"Ada Lovelace","tags":["a","b"],"path":"C:\\tmp","rate":"5%"}`,
	"--compressed",
];
