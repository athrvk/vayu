/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HTTP status classes, and the colours for them - the single source of truth.
 *
 * Five places classified status codes for colour and gave four different
 * answers for 3xx: amber on the response badge, violet in the dashboard chart,
 * a raw `blue-*` tile in the history overview, and `status-running-text` in the
 * dashboard's request view. 4xx had three answers. So the app taught you
 * "violet means redirect" on one screen and showed you an amber 301 on another.
 *
 * The same shape as `load-test-modes.ts`, and for the same reason: one concept
 * spread across several hardcoded branches drifts, and each copy makes the next
 * rename look risky enough to skip.
 *
 * What is unified here is the *classification* - which class a code belongs to.
 * Palettes are not, and should not be: the dashboard's uPlot series resolve
 * through `ROLE_TOKEN` to `--success` / `--warning` / `--chart-3`, which hold
 * different values from `--status-*`. A translucent area fill on a plot, a
 * solid chip under a white label and a 10% wash are different optical problems
 * and already have separate tiers. `--status-redirect` and `--chart-3` are
 * therefore two tokens for one concept, sharing hue 258 by construction and
 * coinciding exactly only in the dark text tier. Keep them in step by hand.
 */

export type HttpStatusClass =
	| "success"
	| "redirect"
	| "client-error"
	| "server-error"
	| "no-response";

/**
 * Which class a status code belongs to.
 *
 * Every input has a stated answer. The inline branches this replaces all ended
 * in a bare `else` that funnelled everything unmatched into the server-error
 * colour, so a `101 Switching Protocols` painted red and a connection failure
 * was indistinguishable from a 500.
 *
 * `1xx` groups with `redirect` because both say the same thing - this is not
 * the final answer, something else follows. Anything that is not a valid
 * response at all (`0`, negative, `>= 600`, `NaN`) is `no-response`, never an
 * error colour: "the server said no" and "there was no server" are different
 * facts and the user acts on them differently.
 */
export function httpStatusClass(code: number): HttpStatusClass {
	if (!Number.isFinite(code) || code < 100 || code >= 600) return "no-response";
	if (code >= 500) return "server-error";
	if (code >= 400) return "client-error";
	if (code >= 300) return "redirect";
	if (code >= 200) return "success";
	return "redirect"; // 1xx
}

/**
 * The utility class for each class, per surface role.
 *
 * Every value is a complete literal. Tailwind scans source text, and this repo
 * has no `@source inline(...)` and no safelist - verified, not assumed - so a
 * composed `bg-${stem}-fill` would produce no CSS at all and fail as a silently
 * uncoloured element, most likely only in a production build.
 *
 * Keyed by role rather than by token tier so the caller has to name what the
 * colour is *doing*. Using a solid fill as a foreground is, per CLAUDE.md, the
 * most common colour bug in this codebase; picking `.fill` when you meant
 * `.text` now takes a deliberate wrong word rather than a mis-assembled string.
 */
export interface StatusClassStyle {
	/** Solid chip under a white label - the response status badge. */
	fill: string;
	/** The colour *is* the text - a status code, a count. */
	text: string;
	/** Tinted panel behind other content - the history overview tiles. */
	tint: string;
}

/*
 * There is deliberately no `indicator` tier here.
 *
 * The obvious fourth entry would be the bare `--status-*` token for dots and
 * icons, and it was written first. Nothing consumed it: the badge takes `fill`,
 * the tiles take `tint` and `text`, the dashboard takes `text`. An unused field
 * is exactly the written-but-never-read shape this codebase keeps producing,
 * and `status-color-tokens.test.ts` rightly flagged the bare `text-status-*`
 * strings it introduced. Add it when a caller needs it, with the 3.0 icon bar
 * in mind rather than the 4.5 text bar.
 */

export const STATUS_CLASS_STYLE: Record<HttpStatusClass, StatusClassStyle> = {
	success: {
		fill: "bg-status-success-fill",
		text: "text-status-success-text",
		tint: "bg-status-success/10",
	},
	redirect: {
		fill: "bg-status-redirect-fill",
		text: "text-status-redirect-text",
		tint: "bg-status-redirect/10",
	},
	"client-error": {
		fill: "bg-status-warning-fill",
		text: "text-status-warning-text",
		tint: "bg-status-warning/10",
	},
	"server-error": {
		fill: "bg-status-error-fill",
		text: "text-status-error-text",
		tint: "bg-status-error/10",
	},
	"no-response": {
		fill: "bg-status-no-response-fill",
		text: "text-status-no-response-text",
		tint: "bg-status-no-response/10",
	},
};

/**
 * What to print when there is no number to print.
 *
 * Only `no-response` has a label of its own - the others show the code itself.
 * It lived as a bare `"ERR"` in two badges, one of which had lost the branch
 * that produced it and rendered a literal `0`.
 */
export const STATUS_CLASS_LABEL: Record<HttpStatusClass, string | null> = {
	success: null,
	redirect: null,
	"client-error": null,
	"server-error": null,
	"no-response": "ERR",
};

/** What a status badge should show: the code, or `ERR` when nothing came back. */
export function statusCodeLabel(code: number): string {
	return STATUS_CLASS_LABEL[httpStatusClass(code)] ?? String(code);
}
