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
 * back with exactly three differences: the sentence at the top, the reference
 * block at the bottom (now one line, see `contextNote`), and which fields they
 * bind. Roughly 130 lines - the variable scanning, the referenced-name chips,
 * the full-scope list, the editor, the notices - were identical line for line.
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
	/** What the editor announces itself as. Both panels mount one `CodeEditor`. */
	editorLabel: string;
	/** Collection scripts that run before this one, when the host supplies them. */
	inheritedKey: Extract<
		keyof RequestBuilderContextValue,
		"inheritedPreScripts" | "inheritedPostScripts"
	>;
	/** The whole glued script a legacy run recorded. */
	legacyKey: Extract<keyof RequestBuilderContextValue, "legacyPreScript" | "legacyPostScript">;
	/** The sentence above the editor. */
	intro: ReactNode;
	/**
	 * The one line below the editor: the fact about *this* script kind that the
	 * editor itself cannot tell you.
	 *
	 * This replaced a 14-line reference block and nine paragraphs of rules
	 * (#1223). Every rule they carried is in the engine's completion table, which
	 * Monaco shows on hover and completion, or in the two docs pages the link
	 * beside this line opens - both of which a script author reaches from inside
	 * the editor. What is left here is what neither surface can say, because it
	 * is about the hook rather than about a member: a pre-request script does not
	 * run under load at all, and in a test script the assertion styles split.
	 */
	contextNote: ReactNode;
}

/** Inline code in the intro sentence. A bare element, not a component - a
    component declared beside exported data trips react-refresh. */
const CODE_CLASS = "bg-muted px-1 rounded-md";

export const SCRIPT_VARIANTS: Record<ScriptVariant, ScriptVariantConfig> = {
	pre: {
		field: "preRequestScript",
		editorLabel: "Pre-request script",
		inheritedKey: "inheritedPreScripts",
		legacyKey: "legacyPreScript",
		intro: (
			<>
				Execute JavaScript before sending the request. Use the{" "}
				<code className={CODE_CLASS}>pm</code> API. Edits to{" "}
				<code className={CODE_CLASS}>pm.request</code> change what is actually sent.
			</>
		),
		contextNote: (
			<>
				Load tests do not run pre-request scripts at all - this one runs on Send and in a
				collection run.
			</>
		),
	},
	post: {
		field: "testScript",
		editorLabel: "Test script",
		inheritedKey: "inheritedPostScripts",
		legacyKey: "legacyPostScript",
		intro: (
			<>
				Execute JavaScript after receiving the response. Use{" "}
				<code className={CODE_CLASS}>pm.test()</code> for assertions.
			</>
		),
		contextNote: (
			<>
				<code className={CODE_CLASS}>pm.response.to</code> asserts about the response
				itself; <code className={CODE_CLASS}>pm.expect</code> asserts about any value you
				hand it.
			</>
		),
	},
};
