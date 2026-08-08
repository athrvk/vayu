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
 * a `SnippetRequest`, so the whole surface is unit-testable without a renderer,
 * and adding httpie or PowerShell later means one more entry in `CODE_TARGETS`
 * and nothing else.
 *
 * The input the UI feeds these is `POST /compose`'s output - the fully resolved
 * request, variables substituted and `inherit` auth walked - so a Vayu snippet
 * is what will actually be sent rather than the template it was written as.
 * That is a promise a template-based generator cannot make.
 */

import { generateCurl } from "./curl";
import { generateFetch } from "./fetch";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

export type CodeTargetId = "curl" | "fetch";

export interface CodeTarget {
	id: CodeTargetId;
	label: string;
	/** For the syntax highlighter and for the copied snippet's file extension. */
	language: "bash" | "javascript";
	generate: (request: SnippetRequest, options?: CodegenOptions) => GeneratedSnippet;
}

export const CODE_TARGETS: readonly CodeTarget[] = [
	{ id: "curl", label: "curl", language: "bash", generate: generateCurl },
	{ id: "fetch", label: "JS fetch", language: "javascript", generate: generateFetch },
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
export { authSecrets } from "./prepare";
export { SECRET_PLACEHOLDER } from "./types";
export type { CodegenOptions, GeneratedSnippet, SnippetBody, SnippetRequest } from "./types";
