/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shapes the snippet generators read.
 *
 * Structural, deliberately not an import of `ComposedRequest`: the generators are pure functions
 * with no opinion about where their input came from, and both entry points feed them the same
 * fields (`POST /compose`'s resolved payload, and the stored request mapped to that shape for the
 * templated view). `ComposedRequest` satisfies `SnippetRequest` structurally, so the call site
 * needs no conversion.
 */

import type { HttpVersion } from "@/constants/request";
import type { HeaderLine, KeyValueEntry } from "@/types";

/**
 * The body shape the engine takes on `/compose`, `/execute` and `/runs`
 * (`ExecBody` in the request builder) and hands back composed. Field-based
 * modes carry `fields`, `binary` carries `file`, and every other mode carries
 * `content`.
 */
export interface SnippetBody {
	mode: string;
	content?: string;
	/** The `binary` mode's file: the whole body is this file's bytes. */
	file?: {
		src?: string;
		fileName?: string;
		contentType?: string;
	};
	fields?: Array<{
		key: string;
		value: string;
		enabled?: boolean;
		/** `form-data` file parts (issue #393): the path the engine uploads. */
		type?: "text" | "file";
		src?: string;
		fileName?: string;
		/** A file part's type, or the one a `form-data` text part declares (#2539). */
		contentType?: string;
	}>;
}

export interface SnippetRequest {
	method: string;
	url: string;
	/**
	 * The request's params rows, read for its path rows only (#1764): a `:name` segment of `url` is
	 * substituted from them exactly as the engine composes it (`substitutePathVariables`). The
	 * query is already in `url`. On a composed payload, these are the path rows composition left
	 * waiting (a value holding a token only a run answers), whose `:name` is still in `url`.
	 */
	params?: readonly KeyValueEntry[];
	/**
	 * Ordered lines, as `POST /compose` returns them and as the Headers table
	 * reads: a repeated name is repeated (issue #2466). A record is the older
	 * single-valued shape, read in its key order.
	 */
	headers?: HeaderLine[] | Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;
	/**
	 * Consume the response as a `text/event-stream` (#575). An execution setting, not a transfer
	 * option, so it changes what a snippet has to *say*: curl and HTTPie have a first-class
	 * unbuffered mode and emit it, and the targets whose stock idiom buffers the whole body say so
	 * in a note instead of emitting a command that would hang on an endless stream.
	 */
	stream?: boolean;
	/**
	 * Verify the TLS certificate (#706). Default `true`, and the snippet says anything only when it
	 * is off: `curl -k` is the flag `parseCurl` reads back, so a request pasted from a command that
	 * turned verification off regenerates the command it came from. Targets with no first-class
	 * spelling for it carry a note instead of silently emitting a verifying request, the split
	 * `stream` takes.
	 */
	verifySSL?: boolean;
	/**
	 * Follow redirects (#1445). Default `true`, the engine's own default and unlike curl's, so
	 * `curl -L` is the flag `parseCurl` reads back: a request pasted from a command with no `-L`
	 * came from one that does not follow, and the generated command for a following request needs
	 * it to do the same.
	 */
	followRedirects?: boolean;
	/**
	 * Redirect hops allowed while {@link followRedirects} is on (the engine caps
	 * at 10 unless told otherwise). Said only when following: a request that does
	 * not follow has no hops to count. curl and HTTPie have a flag for it, and
	 * the targets with none carry a note.
	 */
	maxRedirects?: number;
	/**
	 * The request's own deadline in milliseconds (#2937), `null` or absent when it states none.
	 * Then the engine's `defaultTimeout` setting decides at send time, which a snippet cannot know,
	 * so nothing is emitted and nothing is said, the reading `POST /compose` takes.
	 */
	timeout?: number | null;
	/**
	 * The protocol the request asks for. Only curl has a flag for it; `auto`
	 * (and absent) lets the client negotiate, which is what every target does
	 * unasked, so nothing is emitted for it and no other target says anything.
	 */
	httpVersion?: HttpVersion;
	/**
	 * The request's `disableUrlEncoding` (#1765). Default `false`. On, a `:name` path value and an
	 * API-key query param go into the URL as written, as the engine sends them; the snippet quotes
	 * that URL unchanged.
	 */
	disableUrlEncoding?: boolean;
}

export interface CodegenOptions {
	/**
	 * Values to hide before the snippet is built, each replaced wherever it occurs (a URL, a
	 * header, a body): a secret variable substitutes into all three, and a generator that masked
	 * only the auth field would leak the same value one line down.
	 */
	secrets?: string[];
	/** Off produces the real values; on is the default the UI ships with. */
	mask?: boolean;
}

export interface GeneratedSnippet {
	code: string;
	/**
	 * What the snippet cannot carry, in the user's words: an auth mode the engine performs at send
	 * time that no static command can reproduce, or the jar cookies libcurl attaches on the wire.
	 * Rendered beside the code, not buried in it: a snippet that silently drops a credential is
	 * worse than one that says it did.
	 */
	notes: string[];
	/** Whether any masking actually happened, so the UI can say "masked". */
	masked: boolean;
}

/** The placeholder a masked value is replaced with. Never a plausible value. */
export const SECRET_PLACEHOLDER = "<secret>";

/**
 * What a secret becomes where the UI shows resolved text (the "Sends" line, the
 * key/value Σ peek): a fixed stand-in, once per value, so the text does not
 * give away the secret's length.
 */
export const SECRET_UI_MASK = "••••";
