/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shapes the snippet generators read.
 *
 * Deliberately structural rather than an import of `ComposedRequest`: the
 * generators are pure functions with no opinion about where their input came
 * from, and both entry points feed them the same fields - `POST /compose`'s
 * resolved payload, and the stored request mapped to the same shape for the
 * templated view. `ComposedRequest` satisfies `SnippetRequest` structurally, so
 * the call site needs no conversion.
 */

/**
 * The body shape the engine takes on `/compose`, `/execute` and `/runs`
 * (`ExecBody` in the request builder) and hands back composed. Field-based
 * modes carry `fields`; every other mode carries `content`.
 */
export interface SnippetBody {
	mode: string;
	content?: string;
	fields?: Array<{
		key: string;
		value: string;
		enabled?: boolean;
		/** `form-data` file parts (issue #393): the path the engine uploads. */
		type?: "text" | "file";
		src?: string;
		fileName?: string;
		contentType?: string;
	}>;
}

export interface SnippetRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;
	/**
	 * Consume the response as a `text/event-stream` (issue #575).
	 *
	 * An execution setting rather than a transfer option, so it changes what a
	 * snippet has to *say* rather than a flag it passes along: curl and HTTPie
	 * have a first-class unbuffered mode and emit it, and the targets whose
	 * stock idiom buffers the whole body say so in a note instead of emitting a
	 * command that would hang on an endless stream.
	 */
	stream?: boolean;
	/**
	 * Verify the TLS certificate (issue #706). Default `true`, and the snippet
	 * only says anything when it is off - `curl -k` is the flag `parseCurl`
	 * reads back, so a request pasted from a command that turned verification
	 * off regenerates the command it came from. Targets with no first-class
	 * spelling for it carry a note instead of silently emitting a verifying
	 * request, the same split `stream` above takes.
	 */
	verifySSL?: boolean;
	/**
	 * Follow redirects (issue #1445). Default `true` - the engine's own
	 * default, unlike curl's - so `curl -L` is the flag `parseCurl` reads back:
	 * a request pasted from a command with no `-L` came from one that does not
	 * follow, and the generated command for a following request needs it to
	 * describe the same behaviour.
	 */
	followRedirects?: boolean;
}

export interface CodegenOptions {
	/**
	 * Values to hide before the snippet is built. Every one of them is replaced
	 * wherever it occurs - a URL, a header, a body - because a secret variable
	 * substitutes into all three and a generator that only masked the auth field
	 * would leak the same value one line down.
	 */
	secrets?: string[];
	/** Off produces the real values; on is the default the UI ships with. */
	mask?: boolean;
}

export interface GeneratedSnippet {
	code: string;
	/**
	 * What the snippet cannot carry, in the user's words - an auth mode the
	 * engine performs at send time and no static command can reproduce, or the
	 * jar cookies libcurl attaches on the wire. Rendered beside the code rather
	 * than buried in it: a snippet that silently drops a credential is worse
	 * than one that says it did.
	 */
	notes: string[];
	/** Whether any masking actually happened, so the UI can say "masked". */
	masked: boolean;
}

/** The placeholder a masked value is replaced with. Never a plausible value. */
export const SECRET_PLACEHOLDER = "<secret>";
