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
 * and keeps its own copy of these few lines - but a test there can, and does,
 * which is what keeps the two answers the same. Splitting the detector out is
 * what makes that import cheap: `parseCurl.ts` reaches the `@/types` barrel and
 * pulls half the renderer in with it.
 */

export type CommandKind = "curl" | "wget";

/**
 * The command word of a command line: its first word, or the whole of a quoted
 * one (`"C:\Program Files\curl\curl.exe"` holds a space), without its quotes.
 */
function commandWord(stripped: string): string {
	const quote = stripped[0];
	if (quote === '"' || quote === "'") {
		const end = stripped.indexOf(quote, 1);
		return end === -1 ? "" : stripped.slice(1, end);
	}
	return stripped.split(/\s/, 1)[0] ?? "";
}

/**
 * Windows' own build of curl is `curl.exe`, and PowerShell aliases bare `curl`
 * to `Invoke-WebRequest`, so that spelling - alone or after a path
 * (`C:\Windows\System32\curl.exe`, `.\curl.exe`) - is what a Windows user
 * copies. A bare `curl` takes no path: `echo curl` and `/tmp/curl` stay text.
 */
const CURL_EXE = /^(?:.*[\\/])?curl\.exe$/;

/** Detect whether pasted text is a curl or wget command. */
export function detectCommand(text: string): CommandKind | null {
	const stripped = text.trim().replace(/^[$>]\s+/, "");
	const first = commandWord(stripped).toLowerCase();
	if (first === "curl" || CURL_EXE.test(first)) return "curl";
	if (first === "wget") return "wget";
	return null;
}
