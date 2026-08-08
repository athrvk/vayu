/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Generating a runnable snippet for a request.
 *
 * Vayu has parsed curl *in* since early on (`services/curl/`) and generated
 * nothing *out*; this closes that symmetry. Every target is a pure function of
 * a `SnippetRequest`, so the whole surface is unit-testable without a renderer.
 *
 * Adding a target is one entry in `CODE_TARGETS` and one pure function - which
 * is the interface curl and fetch were built behind, and what HTTPie, Python and
 * PowerShell then cost. Quoting is per target, never a flag on another one:
 * PowerShell escapes a quote by doubling it and POSIX by closing and reopening,
 * and a "same generator, different quote character" shortcut is precisely how
 * generators emit broken commands.
 *
 * The input the UI feeds these is `POST /compose`'s output - the fully resolved
 * request, variables substituted and `inherit` auth walked - so a Vayu snippet
 * is what will actually be sent rather than the template it was written as.
 * That is a promise a template-based generator cannot make.
 */

import { generateCurl } from "./curl";
import { generateFetch } from "./fetch";
import { generateHttpie } from "./httpie";
import { generatePowerShell } from "./powershell";
import { generatePython } from "./python";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

export type CodeTargetId = "curl" | "fetch" | "httpie" | "powershell" | "python";

export interface CodeTarget {
	id: CodeTargetId;
	label: string;
	/** For the syntax highlighter and for the copied snippet's file extension. */
	language: "bash" | "javascript" | "powershell" | "python";
	generate: (request: SnippetRequest, options?: CodegenOptions) => GeneratedSnippet;
}

export const CODE_TARGETS: readonly CodeTarget[] = [
	{ id: "curl", label: "curl", language: "bash", generate: generateCurl },
	{ id: "fetch", label: "JS fetch", language: "javascript", generate: generateFetch },
	{ id: "python", label: "Python requests", language: "python", generate: generatePython },
	{ id: "httpie", label: "HTTPie", language: "bash", generate: generateHttpie },
	{
		id: "powershell",
		label: "PowerShell",
		language: "powershell",
		generate: generatePowerShell,
	},
] as const;

export function generateSnippet(
	target: CodeTargetId,
	request: SnippetRequest,
	options?: CodegenOptions
): GeneratedSnippet {
	const entry = CODE_TARGETS.find((t) => t.id === target);
	// Not a fallback to curl: a target id that is not in the registry is a call
	// site out of step with it, and silently generating the wrong language would
	// be copied straight into a terminal.
	if (!entry) throw new Error(`Unknown code target: ${target}`);
	return entry.generate(request, options);
}

export { generateCurl } from "./curl";
export { generateFetch } from "./fetch";
export { generateHttpie } from "./httpie";
export { generatePowerShell } from "./powershell";
export { generatePython } from "./python";
export { authSecrets } from "./prepare";
export { SECRET_PLACEHOLDER } from "./types";
export type { CodegenOptions, GeneratedSnippet, SnippetBody, SnippetRequest } from "./types";
