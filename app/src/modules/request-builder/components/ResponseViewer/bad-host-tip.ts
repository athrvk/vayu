/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tip for an `INVALID_URL` whose host holds a `{{variable}}` (#3500).
 *
 * A variable nothing defines is sent as written, so the target is
 * `http://{{host}}/...` and libcurl answers "URL rejected: Bad hostname", which
 * names neither the variable nor the fact that it was one. The engine's message
 * is all the failure carries, so the tip is built from the URL as the user wrote
 * it (`ResponseState.sentRequest`): it names the variables in the host, and says
 * what an undefined one does rather than claiming this one was, because the
 * snapshot is the template, not what the engine resolved it to.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { pickByCount } from "@/modules/dashboard/utils/format";

/** The scheme and userinfo are not the host; the port and the host's labels are kept. */
const AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)/i;

/**
 * The `{{names}}` in `url`'s host, each once, in order. A generator
 * (`{{$guid}}`) always resolves, so it is never the cause and is left out.
 */
export function hostVariables(url: string): string[] {
	const authority = AUTHORITY.exec(url)?.[1] ?? "";
	const host = authority.slice(authority.lastIndexOf("@") + 1);
	const names = [...host.matchAll(VARIABLE_PATTERN)]
		.map((match) => match[1].trim())
		.filter((name) => !name.startsWith("$"));
	return [...new Set(names)];
}

/** "a", "a and b", "a, b, and c". */
function listed(names: readonly string[]): string {
	if (names.length <= 2) return names.join(" and ");
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The tip for a send to `url` that was refused, or undefined when no variable is in its host. */
export function badHostTip(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const names = hostVariables(url).map((name) => `{{${name}}}`);
	if (names.length === 0) return undefined;
	const named = listed(names);
	return pickByCount(names.length, {
		one: `The host uses ${named}. If that variable isn't defined, the host is sent as written and isn't a valid name - define it in the active environment or globals.`,
		other: `The host uses ${named}. If any of those variables isn't defined, the host is sent as written and isn't a valid name - define it in the active environment or globals.`,
	});
}
