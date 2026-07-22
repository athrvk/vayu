/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseAnnouncer
 *
 * Sending a request is the primary action in the app, and until now its result
 * was conveyed only visually: the status badge, time and size appear in a pane
 * that never receives focus, so a screen reader user pressed Send (or
 * Ctrl/Cmd+Enter, which moves focus nowhere at all) and heard nothing back.
 * There was no live region anywhere in the request builder or response viewer.
 *
 * This is the same fix as the Toaster, and it carries the same constraint: a
 * live region has to already be in the DOM for a change to it to be observed.
 * So this component is rendered unconditionally by RequestBuilderLayout and is
 * empty until there is something to say - never mounted alongside its own
 * message.
 *
 * Polite, including for failures. A response is the end of an action the user
 * just took, so there is nothing to interrupt; `assertive` would cut off
 * whatever they were reading to tell them about something they asked for. Same
 * call as the toasts.
 */

import { useState } from "react";
import { useRequestBuilderContext } from "../context";

function formatMs(ms: number): string {
	// Spoken, not read. The header's four decimal places are unusable as speech.
	if (ms < 1) return "under a millisecond";
	if (ms < 1000) return `${Math.round(ms)} milliseconds`;
	return `${(ms / 1000).toFixed(1)} seconds`;
}

export default function ResponseAnnouncer() {
	const { response, isExecuting } = useRequestBuilderContext();

	// A live region is announced when its content changes in the DOM. If two
	// responses produce byte-identical text React never touches the node, and
	// the second one is silent - resending the same request and hearing nothing
	// reads as the app having failed to send. Bumping a key on each new response
	// object replaces the text node, so the announcement fires either way.
	//
	// React's adjust-state-during-render pattern, not a ref and not an effect.
	// Refs are lint-banned here (and rightly: this value is rendered, so it is
	// not ref material), and an effect would announce a paint late. React
	// re-runs this component immediately with the new state, before touching the
	// DOM, so the extra pass is not visible.
	const [lastResponse, setLastResponse] = useState(response);
	const [seq, setSeq] = useState(0);
	if (lastResponse !== response) {
		setLastResponse(response);
		setSeq((n) => n + 1);
	}

	let message = "";
	if (isExecuting) {
		// Ctrl/Cmd+Enter gives no other feedback: focus does not move and the
		// Send button's label change is not announced unless it happens to be
		// the focused element.
		message = "Sending request";
	} else if (response) {
		if (response.status === 0) {
			// No server response - status 0 is the client-side failure sentinel,
			// and "0" is not a status code worth speaking.
			message = `Request failed. ${response.errorMessage || response.errorCode || "No response from server"}`;
		} else {
			const parts = [
				`${response.status} ${response.statusText}`.trim(),
				formatMs(response.time),
			];
			const tests = response.testResults;
			if (tests && tests.length > 0) {
				const failed = tests.filter((t) => !t.passed).length;
				parts.push(
					failed === 0
						? `${tests.length} ${tests.length === 1 ? "test" : "tests"} passed`
						: `${failed} of ${tests.length} tests failed`
				);
			}
			message = `Response ${parts.join(", ")}`;
		}
	}

	return (
		<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
			{/*
			 * aria-atomic is set rather than left to the default. `role="status"`
			 * carries an implicit aria-atomic="true", and here that implicit value
			 * is the one we want - but the Toaster shipped assuming the default was
			 * false and was wrong, so it is written down at both call sites now.
			 * One utterance, whole message, is correct for a single-line region.
			 */}
			<span key={seq}>{message}</span>
		</div>
	);
}
