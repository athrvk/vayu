/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Everything that differs between the pre-request and test script panels.
 *
 * A `diff` of the two old files, with the field names normalised away, came
 * back with exactly three differences: the sentence at the top, the
 * quick-reference block at the bottom, and which fields they bind. Roughly 130
 * lines - the variable scanning, the referenced-name chips, the full-scope
 * list, the editor, the notices - were identical line for line.
 *
 * Both files said so, and asked the next reader to "change them together".
 * That request is the cost: this session had to change both to fix one border
 * token, and the only thing making it safe was a test that happened to run
 * every assertion twice. The differences are data now, so there is no second
 * copy to keep in step.
 *
 * **Every binding lives in this table**, including the context keys. Reading
 * `inheritedPreScripts` inline in the component and the field name from here
 * would be the split this codebase keeps rediscovering - config one branch
 * defines and another re-derives.
 */

import type { ReactNode } from "react";
import type { RequestBuilderContextValue, RequestState } from "../../../../types";

export type ScriptVariant = "pre" | "post";

export interface ScriptVariantConfig {
	/** The `RequestState` field this panel edits. */
	field: Extract<keyof RequestState, "preRequestScript" | "testScript">;
	/** Collection scripts that run before this one, when the host supplies them. */
	inheritedKey: Extract<
		keyof RequestBuilderContextValue,
		"inheritedPreScripts" | "inheritedPostScripts"
	>;
	/** The whole glued script a legacy run recorded. */
	legacyKey: Extract<keyof RequestBuilderContextValue, "legacyPreScript" | "legacyPostScript">;
	/** The sentence above the editor. */
	intro: ReactNode;
	/** The block below it. Lines, so the panel owns the `<br/>` rhythm. */
	quickReference: ReactNode[];
	/**
	 * Rules the quick reference cannot show, listed under it.
	 *
	 * Exists for `pm.request` write-back: a pre-request script can now change
	 * the outgoing request, and every rule that governs it (the object is
	 * authoritative, a script beats the Auth tab, a bad value refuses the whole
	 * edit) is invisible from the snippet alone. Leaving them only in
	 * `docs/engine/scripting.md` puts them where the person writing the script
	 * is not.
	 */
	notes: ReactNode[];
}

/** Inline code in the intro sentence. A bare element, not a component - a
    component declared beside exported data trips react-refresh. */
const CODE_CLASS = "bg-muted px-1 rounded-md";

export const SCRIPT_VARIANTS: Record<ScriptVariant, ScriptVariantConfig> = {
	pre: {
		field: "preRequestScript",
		inheritedKey: "inheritedPreScripts",
		legacyKey: "legacyPreScript",
		intro: (
			<>
				Execute JavaScript before sending the request. Use the{" "}
				<code className={CODE_CLASS}>pm</code> API. Edits to{" "}
				<code className={CODE_CLASS}>pm.request</code> change what is actually sent.
			</>
		),
		quickReference: [
			'pm.environment.get("variable")',
			'pm.environment.set("key", "value")',
			'pm.globals.get("variable")',
			'pm.collectionVariables.get("variable")',
			'pm.request.headers["X-Timestamp"] = Date.now().toString()',
			'pm.request.headers.upsert("X-Trace", traceId)',
			'delete pm.request.headers["Authorization"]',
			'pm.request.url.query.get("page")',
			'pm.request.url.query.upsert({ key: "page", value: 2 })',
			'pm.request.url = "https://api.example.com/v2/users"',
			"pm.request.body = JSON.stringify({ n: 2 })",
			"pm.sendRequest(url, (err, res) => { ... })",
			"pm.info.requestName",
		],
		notes: [
			<>
				<code className={CODE_CLASS}>url</code>, <code className={CODE_CLASS}>method</code>,{" "}
				<code className={CODE_CLASS}>headers</code> and{" "}
				<code className={CODE_CLASS}>body</code> are writable here. Whatever they hold when
				the script ends is what goes on the wire, so{" "}
				<code className={CODE_CLASS}>delete</code> removes a header.
			</>,
			<>
				A script wins over the <strong>Auth</strong> tab - auth is applied before the script
				runs, so setting <code className={CODE_CLASS}>Authorization</code> here replaces it.
			</>,
			<>
				<code className={CODE_CLASS}>url</code> is Postman&apos;s URL object -{" "}
				<code className={CODE_CLASS}>protocol</code>,{" "}
				<code className={CODE_CLASS}>host</code>, <code className={CODE_CLASS}>path</code>,{" "}
				<code className={CODE_CLASS}>query</code> and{" "}
				<code className={CODE_CLASS}>getQueryString()</code> - and still reads as the full
				URL string everywhere except <code className={CODE_CLASS}>===</code> and{" "}
				<code className={CODE_CLASS}>typeof</code>. Edit a member -{" "}
				<code className={CODE_CLASS}>path.push</code>,{" "}
				<code className={CODE_CLASS}>query.add</code> - or assign a whole URL string.
			</>,
			<>
				Indexing is case-sensitive in JS: use the exact name (
				<code className={CODE_CLASS}>Authorization</code>, not{" "}
				<code className={CODE_CLASS}>authorization</code>). The methods -{" "}
				<code className={CODE_CLASS}>get</code>, <code className={CODE_CLASS}>has</code>,{" "}
				<code className={CODE_CLASS}>upsert</code>, <code className={CODE_CLASS}>add</code>,{" "}
				<code className={CODE_CLASS}>remove</code> - are not, and{" "}
				<code className={CODE_CLASS}>add</code> throws on a name that is already there.
			</>,
			<>
				A value the engine cannot send rejects the whole edit and the request is sent
				unchanged - the reason appears in the response pane&apos;s <strong>Console</strong>{" "}
				tab.
			</>,
			<>
				Sign what you send with <code className={CODE_CLASS}>pm.crypto.hmacSha256</code> or{" "}
				<code className={CODE_CLASS}>pm.crypto.sha256</code> (synchronous, hex by default);{" "}
				<code className={CODE_CLASS}>btoa</code> / <code className={CODE_CLASS}>atob</code>{" "}
				are there too. No <code className={CODE_CLASS}>URL</code> parser in the sandbox, and
				load tests do not run pre-request scripts at all.
			</>,
			<>
				<code className={CODE_CLASS}>pm.sendRequest</code> fetches a token before the
				request goes out. It is synchronous - the callback runs before it returns, and there
				is no promise form - and bounded: its timeout is capped at whatever is left of the
				script&apos;s time budget, and one script may send at most 10 requests. Connection,
				DNS and timeout failures arrive as the callback&apos;s first argument rather than
				throwing.
			</>,
			<>
				<code className={CODE_CLASS}>pm.info</code> says where the script is running:{" "}
				<code className={CODE_CLASS}>eventName</code> is{" "}
				<code className={CODE_CLASS}>&quot;prerequest&quot;</code> here and{" "}
				<code className={CODE_CLASS}>&quot;test&quot;</code> in the <strong>Tests</strong>{" "}
				tab, alongside <code className={CODE_CLASS}>requestId</code> and{" "}
				<code className={CODE_CLASS}>requestName</code>. Those two are{" "}
				<code className={CODE_CLASS}>undefined</code> for an unsaved or unnamed request, so
				check before using them.
			</>,
		],
	},
	post: {
		field: "testScript",
		inheritedKey: "inheritedPostScripts",
		legacyKey: "legacyPostScript",
		intro: (
			<>
				Execute JavaScript after receiving the response. Use{" "}
				<code className={CODE_CLASS}>pm.test()</code> for assertions.
			</>
		),
		quickReference: [
			'pm.test("Test name", () => {',
			"  pm.response.to.have.status(200);",
			"});",
			"pm.response.json()",
			"pm.response.text()",
			'pm.response.headers.get("Content-Type")',
			"pm.response.reason()",
			"pm.response.size().total",
			"pm.info.requestName",
		],
		notes: [
			<>
				<code className={CODE_CLASS}>pm.response.headers</code> is a plain object with{" "}
				<code className={CODE_CLASS}>get()</code> /{" "}
				<code className={CODE_CLASS}>has()</code> over it. Those two are case-insensitive;
				indexing is not, and the engine lower-cases every key as it parses the response - so{" "}
				<code className={CODE_CLASS}>headers[&quot;content-type&quot;]</code> needs the
				lower-cased name while <code className={CODE_CLASS}>get()</code> does not.
			</>,
			<>
				<code className={CODE_CLASS}>pm.request</code> is readable here as a record of what
				was sent, but writing to it does nothing - the request has already gone out. Change
				it in the <strong>Pre-request</strong> tab instead.
			</>,
			<>Under load this runs against sampled responses, not every one.</>,
			<>
				<code className={CODE_CLASS}>pm.info</code> says where the script is running:{" "}
				<code className={CODE_CLASS}>eventName</code> is{" "}
				<code className={CODE_CLASS}>&quot;test&quot;</code> here and{" "}
				<code className={CODE_CLASS}>&quot;prerequest&quot;</code> in the{" "}
				<strong>Pre-request</strong> tab, alongside{" "}
				<code className={CODE_CLASS}>requestId</code> and{" "}
				<code className={CODE_CLASS}>requestName</code>. Those two are{" "}
				<code className={CODE_CLASS}>undefined</code> for an unsaved or unnamed request, so
				check before using them.
			</>,
		],
	},
};
