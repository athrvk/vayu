/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HTTP status classes, and the colours for them: the single source of truth. Five places
 * classifying codes for colour gave four answers for 3xx and three for 4xx, so one screen taught
 * "violet means redirect" while another showed an amber 301. The same shape as
 * `load-test-modes.ts`, for the same reason: one concept spread across hard-coded branches drifts,
 * and each copy makes the next rename look too risky to do.
 *
 * What is unified is the classification, which class a code belongs to. Palettes are not, and
 * should not be: the dashboard's uPlot series resolve through `ROLE_TOKEN` to `--success` /
 * `--warning` / `--chart-3`, which hold different values from `--status-*`. A translucent area fill
 * on a plot, a solid chip under a white label and a 10% wash are different optical problems and
 * already have separate tiers. `--status-redirect` and `--chart-3` are therefore two tokens for one
 * concept, sharing hue 258 by construction and coinciding exactly only in the dark text tier. Keep
 * them in step by hand.
 */

export type HttpStatusClass =
	"success" | "redirect" | "client-error" | "server-error" | "no-response";

/**
 * Which class a status code belongs to. Every input has a stated answer: a bare `else` funnelling
 * everything unmatched into the server-error colour paints a `101 Switching Protocols` red and
 * makes a connection failure look like a 500. `1xx` groups with `redirect` because both say the
 * same thing: not the final answer, something else follows. Anything that is not a valid response
 * at all (`0`, negative, `>= 600`, `NaN`) is `no-response`, never an error colour: "the server said
 * no" and "there was no server" are different facts, and the user acts on them differently.
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
 * Does this status count as an error? The renderer's copy of the engine's one definition
 * (`vayu::is_success_status`, #2124): 200-399 succeeds, and every other code is an error (4xx, 5xx,
 * a stray 1xx, and the 0 a transport failure is recorded under). Deliberately not
 * `httpStatusClass`, which answers which colour a code wears (1xx groups with redirect, `0` is its
 * own non-error class): a row that says "this one failed" must agree with the run's error tally
 * instead.
 */
export function isErrorStatus(code: number): boolean {
	return !(code >= 200 && code < 400);
}

/**
 * The utility class for each class, per surface role. Every value is a complete literal: Tailwind
 * scans source text, and this repo has no `@source inline(...)` and no safelist (verified, not
 * assumed), so a composed `bg-${stem}-fill` would produce no CSS at all and fail as a silently
 * uncoloured element, most likely only in a production build. Keyed by role, not by token tier, so
 * the caller has to name what the colour is doing: a solid fill used as a foreground is, per
 * CLAUDE.md, the most common colour bug in this codebase, and picking `.fill` for `.text` now takes
 * a deliberately wrong word, not a mis-assembled string.
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
 * There is deliberately no `indicator` tier here (the bare `--status-*` token for dots and icons):
 * nothing would consume it (the badge takes `fill`, the tiles take `tint` and `text`, the dashboard
 * takes `text`), an unused field is the written-but-never-read shape this codebase keeps producing,
 * and `status-color-tokens.test.ts` flags the bare `text-status-*` strings it would introduce. Add
 * it when a caller needs it, with the 3.0 icon bar in mind rather than the 4.5 text bar.
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
 * The CSS custom property behind each class, for the places that cannot use a Tailwind utility: a
 * Canvas chart handing uPlot a colour string, and the inline-styled legend swatch beside it. Both
 * read from here because a legend with literal colours of its own goes silently wrong when the
 * chart moves palette, and a legend disagreeing with the plot it labels is worse than either being
 * off alone.
 */
export const STATUS_CLASS_CSS_VAR: Record<HttpStatusClass, string> = {
	success: "--status-success",
	redirect: "--status-redirect",
	"client-error": "--status-warning",
	"server-error": "--status-error",
	"no-response": "--status-no-response",
};

/**
 * The status classes in the order a stacked chart and its legend present them,
 * with the short label each is shown by.
 */
export const STATUS_CLASS_SERIES: ReadonlyArray<{ label: string; cls: HttpStatusClass }> = [
	{ label: "2xx", cls: "success" },
	{ label: "3xx", cls: "redirect" },
	{ label: "4xx", cls: "client-error" },
	{ label: "5xx", cls: "server-error" },
	{ label: "err", cls: "no-response" },
];

/**
 * What to print when there is no number to print. Only `no-response` has a label of its own; the
 * others show the code itself. One shared label, because a bare `"ERR"` copied into two badges let
 * one of them lose the branch that produced it and render a literal `0`.
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
