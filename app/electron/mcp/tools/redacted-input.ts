/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief The refusal of a credential slot written with the `<redacted>` marker (#3553), while the
 *        session cannot read secrets.
 *
 * A run's record shows a credential as the marker (`runOutputShape`), and an agent that copies a
 * request out of one writes the marker back. Stored, it replaces the credential with a string that
 * is none; sent, it authenticates with that string. Each check judges the slot as the read that
 * withheld it does (`withhold.ts`), so a field the read never hides (a body, a description) may
 * hold the text, and so may any slot once the user has chosen to reveal secrets: the marker then
 * stands for nothing.
 */

import {
	authCredentialValues,
	isRedactionMarker,
	REDACTED_MARKER,
	redactedUrlSlot,
	withholdsHeaderRow,
} from "../withhold.js";
import type { ToolContext } from "./contract.js";
import { ToolArgError } from "./kit.js";

/** Why a block read with its credentials withheld cannot be written back or sent. */
export const READ_WITHHELD_REASON =
	"it was read with its credentials withheld, so it holds no credential to store or send";

function refuse(what: string): never {
	throw new ToolArgError(
		`${what} holds "${REDACTED_MARKER}": ${READ_WITHHELD_REASON}. Pass the real value or a {{variable}} reference.`,
		"input"
	);
}

/** Refuse an `auth` block with the marker as a credential member's value. */
export function refuseRedactedAuth(ctx: ToolContext, auth: Record<string, unknown>): void {
	if (ctx.config.revealSecretsToAgents) return;
	if (authCredentialValues(auth).some(isRedactionMarker)) refuse('"auth"');
}

/**
 * Refuse a header row with the marker as the value of a credential header,
 * under @p auth's API-key header name. A row with no `value` (a kept row,
 * `valueWithheld: true`) holds nothing to judge.
 */
export function refuseRedactedHeaders(
	ctx: ToolContext,
	rows: readonly { key: string; value?: string }[],
	auth: unknown
): void {
	if (ctx.config.revealSecretsToAgents) return;
	const row = rows.find(
		(candidate) => withholdsHeaderRow(candidate, auth) && isRedactionMarker(candidate.value)
	);
	if (row) refuse(`The "${row.key}" header`);
}

/** Refuse a URL with the marker in a credential slot, under @p auth's API-key query name. */
export function refuseRedactedUrl(ctx: ToolContext, url: unknown, auth: unknown): void {
	if (ctx.config.revealSecretsToAgents || typeof url !== "string") return;
	const slot = redactedUrlSlot(url, auth);
	if (slot !== undefined) refuse(`The URL's ${slot}`);
}

/** Refuse a variable entry that is a secret and holds the marker as its value. */
export function refuseRedactedVariable(
	ctx: ToolContext,
	name: string,
	entry: Record<string, unknown>
): void {
	if (ctx.config.revealSecretsToAgents) return;
	if (entry.secret === true && isRedactionMarker(entry.value)) {
		refuse(`The value of the secret variable "${name}"`);
	}
}
