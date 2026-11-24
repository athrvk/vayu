/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Speaks a send's result: the status badge, time and size appear in a pane that never takes focus,
 * so a screen reader user pressing Send (or Ctrl/Cmd+Enter, which moves focus nowhere) heard
 * nothing. The Toaster's fix and constraint: a live region must already be in the DOM for a change
 * to be observed, so RequestBuilderLayout renders this unconditionally, empty until there is
 * something to say, never mounted with its message. Polite even for failures, as the toasts are: a
 * response ends an action the user just took, and `assertive` would cut off what they were reading.
 */

import { useState } from "react";
import { formatLatencyParts } from "@/lib/format-number";
import { spokenSymbols } from "@/lib/spoken-text";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useRequestBuilderContext } from "../context";

const SPOKEN_UNIT = { ms: "millisecond", s: "second" } as const;

/**
 * The header's number, spoken: the shared digits, so the announcer never disagrees with the pane,
 * and a unit word.
 */
function spokenDuration(ms: number): string {
	const { value, unit } = formatLatencyParts(ms);
	const word = pluralize(Number(value), SPOKEN_UNIT[unit], `${SPOKEN_UNIT[unit]}s`);
	return `${spokenSymbols(value)} ${word}`;
}

export default function ResponseAnnouncer() {
	const { response, isExecuting } = useRequestBuilderContext();

	// A live region speaks when its DOM content changes; two byte-identical responses leave the
	// node untouched and the second is silent, which reads as a failed send. A key bumped per
	// response object replaces the text node, so it always fires. Adjust-state-during-render, not a
	// ref (this value is rendered; refs are lint-banned here) and not an effect (a paint late);
	// React re-runs the component before touching the DOM, so the extra pass is invisible.
	const [lastResponse, setLastResponse] = useState(response);
	const [seq, setSeq] = useState(0);
	if (lastResponse !== response) {
		setLastResponse(response);
		setSeq((n) => n + 1);
	}

	let message = "";
	if (isExecuting) {
		// Ctrl/Cmd+Enter gives no other feedback: focus stays, and Send's label change is announced
		// only if it is focused.
		message = "Sending request…";
	} else if (response) {
		if (response.status === 0) {
			// No server response: status 0 is the client-side failure sentinel, not a code worth
			// speaking.
			message = `Couldn't get a response. ${response.errorMessage || response.errorCode || "The server didn't respond."}`;
		} else {
			const parts = [
				`${response.status} ${response.statusText}`.trim(),
				spokenDuration(response.time),
			];
			const tests = response.testResults;
			if (tests && tests.length > 0) {
				const failed = tests.filter((t) => !t.passed).length;
				parts.push(
					failed === 0
						? `${tests.length} ${pluralize(tests.length, "test")} passed`
						: `${failed} of ${tests.length} tests failed`
				);
			}
			message = `Response ${parts.join(", ")}`;
		}
	}

	return (
		<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
			{/*
			 * aria-atomic is written out: `role="status"` implies "true", the value wanted, but the
			 * Toaster assumed false and was wrong, so both call sites state it. One utterance,
			 * whole message, suits a single-line region.
			 */}
			<span key={seq}>{message}</span>
		</div>
	);
}
