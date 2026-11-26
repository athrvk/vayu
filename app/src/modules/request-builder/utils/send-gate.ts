/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When a Send may run: one predicate for the window handler in `RequestBuilderLayout` and the
 * palette entry in `SendRequestCommandSurface`, since a second spelling would let the chord refuse
 * a send the palette still offered, on the one screen where they must agree.
 *
 * `isStreaming` is the second half of "in flight": once the engine answered and the socket is open,
 * `isExecuting` is false (`RequestBuilderProvider` clears it so the Events tab is not hidden behind
 * "Sending...") while the run goes on. Send *is* Stop for that window (#574), so neither route may
 * replace the open stream with a new one, the run the button in front of you would stop. Stopping
 * is destructive, so it stays a deliberate click. The URL bar reads the two halves itself: it
 * refuses no send but renders Stop while a stream is open and a disabled Send otherwise.
 */
export function canSendRequest(state: {
	url: string;
	isExecuting: boolean;
	isStreaming: boolean;
}): boolean {
	return !state.isExecuting && !state.isStreaming && state.url.trim().length > 0;
}
