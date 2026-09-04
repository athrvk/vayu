/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether some text is a shell command the request builder can import.
 *
 * A leaf of its own, with no imports, because the main process has to ask the
 * same question: the URL bar's context menu offers "Paste as curl" only for a
 * clipboard `importCommand` would accept (#1359). `tsconfig.node.json` has no
 * `@/*` mapping, deliberately, so `electron/context-menu.ts` cannot import this
 * and keeps its own four lines - but a test there can, and does, which is what
 * keeps the two answers the same. Splitting the detector out is what makes that
 * import cheap: `parseCurl.ts` reaches the `@/types` barrel and pulls half the
 * renderer in with it.
 */

export type CommandKind = "curl" | "wget";

/** Detect whether pasted text is a curl or wget command. */
export function detectCommand(text: string): CommandKind | null {
	const stripped = text.trim().replace(/^[$>]\s+/, "");
	const first = stripped.split(/\s/, 1)[0]?.toLowerCase();
	if (first === "curl") return "curl";
	if (first === "wget") return "wget";
	return null;
}
