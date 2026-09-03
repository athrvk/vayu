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
 * **The engine's startup pass owns the stored copy** - it rewrites the rows out
 * of the database once (`strip_legacy_managed_headers` in
 * `engine/src/http/default_headers.cpp`). This is that same rule applied to what
 * a client loads, so a request read before or without that pass still opens
 * clean, and the two must stay identical.
 */

import type { FormFieldEntry, KeyValueItem } from "@/types";
import { toKeyValueItems } from "@/components/shared/KeyValueEditor/key-value";

/** A bare RFC 4122 UUID - the exact shape `generateUUID()` produced. */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Was this stored header row written by a pre-#1229 Vayu client?
 *
 * Three rules, each as narrow as it can be, because acting on this deletes what
 * the user sees as their own data:
 *
 * - `X-Vayu-Version` goes unconditionally. The old editor never let it be
 *   edited, so no value of it was ever anyone's.
 * - `X-Request-ID` goes only when its value is a bare UUID, the shape the old
 *   client generated. A correlation id someone typed stays.
 * - `User-Agent` goes only when its value is a `Vayu/...`. A browser's or a
 *   crawler's `User-Agent` is exactly the header a testing tool exists to send.
 */
export const isLegacyManagedHeader = (key: string, value: string): boolean => {
	switch (key.trim().toLowerCase()) {
		case "x-vayu-version":
			return true;
		case "x-request-id":
			return BARE_UUID.test(value.trim());
		case "user-agent":
			return value.trim().toLowerCase().startsWith("vayu/");
		default:
			return false;
	}
};

/**
 * The stored header entries as editor rows, minus the rows the old client
 * wrote. Every row that survives is the user's, editable and removable like any
 * other; what Vayu itself sends is shown separately, from
 * `GET /request-defaults`.
 */
export const toHeaderItems = (entries: FormFieldEntry[] | undefined): KeyValueItem[] =>
	toKeyValueItems((entries ?? []).filter((e) => !isLegacyManagedHeader(e.key, e.value)));
