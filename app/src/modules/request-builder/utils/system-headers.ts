/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which stored header rows a pre-#1229 client wrote. That client seeded `User-Agent`,
 * `X-Vayu-Version` and a fresh `X-Request-ID` into every request and saved them, so a stored
 * request carried a frozen correlation id a load run replayed every iteration, and a request's
 * headers depended on the client sending it. The engine adds them at send time on every path and
 * declares them over `GET /request-defaults`; this is only the definition of the old rows, dropped
 * on the way into the editor.
 *
 * **The engine's startup pass owns the stored copy**: it disables the rows once rather than
 * deleting them (`strip_legacy_managed_headers`, `engine/src/http/default_headers.cpp`, #1491).
 * This is that rule applied to what a client loads, so a request read before or without the pass
 * opens clean. The two must stay identical: a row hidden here that the engine kept enabled is a
 * header the wire sends and nothing shows. A row the engine disabled and marked
 * `source: "legacy-default"` is left alone: disabling exists so the user can find and re-enable it,
 * and dropping it from the editor's state would remove it on the next save.
 */

import type { FormFieldEntry, KeyValueItem } from "@/types";
import { toKeyValueItems } from "@/components/shared/KeyValueEditor/key-value";

/**
 * A lowercase RFC 4122 v4 UUID, the shape `generateUUID()` produced (version `4`, variant
 * `8`/`9`/`a`/`b`, no uppercase). Mirrors `is_bare_uuid` in `engine/src/http/default_headers.cpp`.
 */
const BARE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A plain `MAJOR.MINOR.PATCH`, the only shape the engine's version has taken. Mirrors
 * `is_plain_semver` in the same file.
 */
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The ASCII whitespace this rule strips, not `String.prototype.trim`, which also strips Unicode
 * spaces (NBSP, U+2028) the engine's copy does not; answering differently is the defect, a row
 * hidden here and kept there being a header on the wire nothing shows. Same set as
 * `TRIMMED_WHITESPACE` in `engine/src/http/default_headers.cpp`.
 */
const ASCII_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

const trimmed = (text: string): string => text.replace(ASCII_TRIM, "");

/**
 * Whether a stored header row was written by a pre-#1229 client. Each rule matches the client's
 * *exact* value shape, not the name or family, because matching more deletes what the user sees as
 * their own data (#1491):
 *
 * - `X-Vayu-Version`: only a plain `MAJOR.MINOR.PATCH`, the only value the old editor wrote; it
 *   allowed no edit, so any other value is someone's own.
 * - `X-Request-ID`: only a lowercase RFC 4122 v4 UUID, as generated; a typed id, or a UUID of
 *   another version or case, stays.
 * - `User-Agent`: only `Vayu/` and that plain version; a browser's or crawler's is exactly what a
 *   testing tool exists to send.
 */
export const isLegacyManagedHeader = (key: string, value: string): boolean => {
	const trimmedValue = trimmed(value);
	switch (trimmed(key).toLowerCase()) {
		case "x-vayu-version":
			return PLAIN_SEMVER.test(trimmedValue);
		case "x-request-id":
			return BARE_UUID_V4.test(trimmedValue);
		case "user-agent": {
			const folded = trimmedValue.toLowerCase();
			return folded.startsWith("vayu/") && PLAIN_SEMVER.test(folded.slice("vayu/".length));
		}
		default:
			return false;
	}
};

/**
 * The stored headers as editor rows, minus the old client's rows the engine's pass has not already
 * disabled. A row with `source: "legacy-default"` is the engine's disabled copy (#1491) and passes
 * like any row, editable and re-enableable, not hidden again and dropped on the next save. What
 * Vayu sends is shown separately, from `GET /request-defaults`.
 */
export const toHeaderItems = (entries: FormFieldEntry[] | undefined): KeyValueItem[] =>
	toKeyValueItems(
		(entries ?? []).filter(
			(e) => e.source === "legacy-default" || !isLegacyManagedHeader(e.key, e.value)
		)
	);
