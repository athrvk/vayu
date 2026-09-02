/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When a Send may actually run - one predicate, two routes.
 *
 * The window handler in `RequestBuilderLayout` and the palette contribution in
 * `SendRequestCommandSurface` both have to answer this, and a second spelling of
 * it is the drift this file exists to prevent: the chord would refuse a send the
 * palette still offered, on the one screen where they must agree.
 *
 * `isStreaming` is the second half of "in flight": once the engine has answered
 * and the socket is open, `isExecuting` goes false while the run is very much
 * still running (`RequestBuilderProvider` clears it deliberately, so the Events
 * tab is not hidden behind "Sending…"). Send *is* Stop for the whole of that
 * window (#574), and neither route may quietly replace the open stream with a
 * new one - the run being replaced being exactly the one the button in front of
 * you would stop. Stopping is destructive, so it stays a deliberate click.
 *
 * The URL bar reads the two halves separately rather than calling this, because
 * it does not refuse a send there - it renders a different control: Stop while a
 * stream is open, a disabled Send otherwise.
 */
export function canSendRequest(state: {
	url: string;
	isExecuting: boolean;
	isStreaming: boolean;
}): boolean {
	return !state.isExecuting && !state.isStreaming && state.url.trim().length > 0;
}
