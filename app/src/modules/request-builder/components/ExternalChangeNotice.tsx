/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A field this tab's draft has touched that an external write (typically an
 * MCP agent's `update_request`) has since changed to a different value
 * (issue #1436) - the per-field conflict `RequestBuilderProvider`'s merge
 * surfaces instead of silently overwriting either side.
 *
 * One callout per logical group rather than per `RequestState` key: the four
 * fields the editor splits a request's body across (`bodyMode`, `body`,
 * `formData`, `urlEncoded`) are one thing to a user, and four separate "body"
 * callouts would look like a bug of their own.
 */

import { ExternalChangeCallout } from "@/components/shared";
import { useRequestBuilderContext } from "../context";
import type { MergeableRequestField } from "../types";

const FIELD_GROUPS: ReadonlyArray<{ label: string; fields: readonly MergeableRequestField[] }> = [
	{ label: "name", fields: ["name"] },
	{ label: "description", fields: ["description"] },
	{ label: "method", fields: ["method"] },
	{ label: "URL", fields: ["url"] },
	{ label: "params", fields: ["params"] },
	{ label: "headers", fields: ["headers"] },
	{ label: "body", fields: ["bodyMode", "body", "formData", "urlEncoded"] },
	{ label: "auth", fields: ["auth"] },
	{ label: "the elements list", fields: ["elements"] },
	{
		label: "settings",
		fields: ["followRedirects", "maxRedirects", "httpVersion", "verifySSL", "stream"],
	},
];

export default function ExternalChangeNotice() {
	const { fieldConflicts, takeExternalField } = useRequestBuilderContext();

	const activeGroups = FIELD_GROUPS.filter(({ fields }) =>
		fields.some((field) => field in fieldConflicts)
	);
	if (activeGroups.length === 0) return null;

	return (
		<>
			{activeGroups.map(({ label, fields }) => (
				<ExternalChangeCallout
					key={label}
					what={label}
					className="mx-4 mt-2"
					onTakeTheirs={() => {
						for (const field of fields) {
							if (field in fieldConflicts) takeExternalField(field);
						}
					}}
				/>
			))}
		</>
	);
}
