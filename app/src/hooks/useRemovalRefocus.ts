/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useRef } from "react";

/**
 * The three things a list has to answer for its own rows. Every one of them is
 * re-resolved at the moment it is used: between the dialog opening and the row
 * leaving, a refetch can have replaced the element under any of them.
 */
export interface RemovalRefocusTargets {
	/** The row the dialog was opened from, or `null` once it is gone. */
	doomed: () => HTMLElement | null;
	/** Where focus belongs once that row is gone. */
	successor: () => HTMLElement | null;
	/** Moves focus, and whatever the list keeps in step with it. */
	focus: (element: HTMLElement) => void;
}

/**
 * Where focus goes after a row is deleted from a list, decided by the outcome
 * rather than by the intent.
 *
 * A delete dialog is rendered controlled with no trigger, and a trigger is what
 * Radix aims its close-focus at - so without this, both outcomes drop the user
 * on `<body>` (#1218). The row is the obvious answer and it is the one thing
 * that may not survive the dialog, so the successor is chosen while it is still
 * on screen: afterwards the DOM cannot say what followed it.
 *
 * Which of the two to use is the part that cannot be answered at close time.
 * `confirmDelete` returns `void`, the dialog closes on failure as much as on
 * success, and by the time an awaited result came back Radix would already have
 * moved focus - so reading the confirm click as the answer sent a *failed*
 * delete's focus to the successor, beside a row that is still sitting there
 * (#1234). The decision is deferred instead of guessed: focus goes back to the
 * row at close, and moves on only once that row actually leaves the DOM. That
 * is the same answer for both outcomes, and it needs no signal out of the
 * mutation.
 *
 * "The row has left" is not a dependency anything can name - the refetch that
 * removes it lands whenever the engine answers, which is usually *after* the
 * dialog has closed - so the wait is a trailing effect that re-checks on every
 * render, the shape `useRevealActiveSelection` uses to wait for a moved row to
 * appear.
 */
export function useRemovalRefocus() {
	const targets = useRef<RemovalRefocusTargets | null>(null);
	const awaitingRemoval = useRef(false);

	/** Call while the row is still on screen: the successor is read from it. */
	const capture = useCallback((next: RemovalRefocusTargets | null) => {
		targets.current = next;
		awaitingRemoval.current = false;
	}, []);

	const settle = useCallback(() => {
		awaitingRemoval.current = false;
		targets.current = null;
	}, []);

	// No dependency array on purpose: see the note above.
	useEffect(() => {
		if (!awaitingRemoval.current) return;
		const plan = targets.current;
		if (!plan) return;

		const doomed = plan.doomed();
		if (doomed) {
			// Still there, so nothing has been decided yet - unless the user has
			// moved on from the row we put them on, in which case there is no
			// longer a deferred move to make.
			if (document.activeElement !== doomed) settle();
			return;
		}

		settle();
		// The row left and took focus to `<body>` with it. Focus anywhere else is
		// somewhere the user chose, and yanking it back is worse than leaving it.
		if (document.activeElement !== document.body) return;
		const successor = plan.successor();
		if (successor) plan.focus(successor);
	});

	const onCloseAutoFocus = useCallback(
		(event: Event) => {
			const plan = targets.current;
			if (!plan) return;

			const doomed = plan.doomed();
			if (doomed) {
				// The delete has not removed it - not yet, or not at all. Focus
				// returns to where the dialog was opened from, and the effect above
				// finishes the move if the row does go.
				event.preventDefault();
				plan.focus(doomed);
				awaitingRemoval.current = true;
				return;
			}

			// Already gone: the refetch beat the dialog's close.
			const successor = plan.successor();
			settle();
			if (!successor) return;
			event.preventDefault();
			plan.focus(successor);
		},
		[settle]
	);

	return { capture, onCloseAutoFocus };
}
