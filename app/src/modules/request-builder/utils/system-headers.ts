/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a pre-#1229 client wrote into a stored request, and how to recognise it.
 *
 * Until issue #1229 this module *created* three headers - `User-Agent`,
 * `X-Vayu-Version` and a fresh `X-Request-ID` - seeded them into every new
 * request, re-imposed them on load, protected them from editing, and saved them
 * with the request. So a stored request carried a frozen correlation id that a
 * load run replayed on every iteration, and the same request went out with a
 * different header set depending on which client sent it.
 *
 * The engine adds those headers now, at send time, on every path, and declares
 * them over `GET /request-defaults` for a client to display. Nothing here
 * creates a header any more; what is left is the one definition of which stored
 * rows the old client wrote, so they can be dropped on the way into the editor.
 *
 * **The engine's startup pass owns the stored copy** - it disables the rows in
 * the database once, rather than deleting them (`strip_legacy_managed_headers`
 * in `engine/src/http/default_headers.cpp`, issue #1491). This is that same
 * rule applied to what a client loads, so a request read before or without that
 * pass still opens clean, and the two must stay identical - a row this side
 * hides that the engine kept enabled is a header the wire sends and nothing
 * shows.
 *
 * A row the engine has already disabled and marked `source: "legacy-default"`
 * is left alone here rather than filtered out a second time: the point of
 * disabling instead of deleting is that the row survives for the user to find
 * and re-enable, and dropping it from the editor's own state would silently
 * remove it again on the next save.
 */

import type { FormFieldEntry, KeyValueItem } from "@/types";
import { toKeyValueItems } from "@/components/shared/KeyValueEditor/key-value";

/**
 * A lowercase RFC 4122 v4 UUID - the exact shape `generateUUID()` produced
 * (version nibble `4`, variant nibble `8`/`9`/`a`/`b`, never an uppercase
 * hex digit). Mirrors `is_bare_uuid` in `engine/src/http/default_headers.cpp`.
 */
const BARE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A plain `MAJOR.MINOR.PATCH` version string - the only shape the engine's
 * own version has ever taken. Mirrors `is_plain_semver` in the same file.
 */
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The ASCII whitespace this rule strips, spelled out rather than left to
 * `String.prototype.trim`.
 *
 * `trim()` also strips Unicode spaces (NBSP, U+2028) that the engine's copy of
 * this rule does not, and the two answering differently is the whole defect:
 * a row this side hid and the engine kept is a header on the wire that nothing
 * shows. Same set as `TRIMMED_WHITESPACE` in
 * `engine/src/http/default_headers.cpp`.
 */
const ASCII_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

const trimmed = (text: string): string => text.replace(ASCII_TRIM, "");

/**
 * Was this stored header row written by a pre-#1229 Vayu client?
 *
 * Three rules, each matching the client's *exact* value shape rather than just
 * the header's name or family, because matching more broadly deletes what the
 * user sees as their own data (issue #1491):
 *
 * - `X-Vayu-Version` matches only a plain `MAJOR.MINOR.PATCH` version, the only
 *   shape the old editor ever wrote there. A hand-typed value of that name -
 *   the old editor never let it be edited, so any other value is someone's own
 *   - stays.
 * - `X-Request-ID` matches only a lowercase RFC 4122 v4 UUID, the exact shape
 *   the old client generated. A correlation id someone typed, or a UUID of
 *   another version or case, stays.
 * - `User-Agent` matches only `Vayu/` followed by that same plain version. A
 *   browser's or a crawler's `User-Agent` is exactly the header a testing tool
 *   exists to send.
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
 * The stored header entries as editor rows, minus the rows the old client
 * wrote and the engine's repair pass has not already disabled. A row already
 * carrying `source: "legacy-default"` is the engine's own disabled-and-marked
 * copy (issue #1491) and passes through like any other row - editable,
 * re-enableable - rather than being hidden a second time and dropped from the
 * editor's state on the next save. What Vayu itself sends is shown separately,
 * from `GET /request-defaults`.
 */
export const toHeaderItems = (entries: FormFieldEntry[] | undefined): KeyValueItem[] =>
	toKeyValueItems(
		(entries ?? []).filter(
			(e) => e.source === "legacy-default" || !isLegacyManagedHeader(e.key, e.value)
		)
	);
