/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One slot: the operation the context bar's outline asked the query editor to
 * scroll to, until the editor has scrolled to it.
 *
 * **A store because the two ends cannot see each other.** The outline lives in
 * the context bar, which sits outside `RequestBuilderProvider`; the Monaco
 * instance lives inside `GraphQLBody` and stays there deliberately - the
 * insert machinery already applies edits in-component rather than handing the
 * editor out, and a second way to reach it would be a second thing to keep
 * correct. What crosses the boundary is a request to reveal, not an editor.
 *
 * **Consume-and-clear, for the reason the insertion effect records.** A command
 * left in the slot after it has been served is replayed the next time anything
 * re-renders or remounts, and the Body tab remounts on every glance at Headers -
 * so the editor would jump back to an operation the user scrolled away from
 * minutes ago. The consumer clears the slot, including when it could not serve
 * the command (the operation has since been renamed away), because an unservable
 * command that stays is the same replay with worse odds.
 *
 * **A command names the request it was written for.** Only one request builder
 * is mounted at a time, so the mismatch takes a click and a tab switch in the
 * same tick - and the cost of not carrying the id is another request's editor
 * jumping to a line number that means nothing there. Same rule, same reason, as
 * the body drafts (`request-builder/utils/body-drafts.ts`).
 */

import { create } from "zustand";
import type { OperationRef } from "./graphql-body";

export interface OperationRevealCommand extends OperationRef {
	/** The request whose editor should scroll. Null for an unsaved request. */
	requestId: string | null;
}

interface RevealState {
	/** The command awaiting an editor, or null when there is nothing to serve. */
	pending: OperationRevealCommand | null;
	revealOperation: (command: OperationRevealCommand) => void;
	/** Drop the command, served or not. Called by whoever decided its fate. */
	clearReveal: () => void;
}

export const useRevealStore = create<RevealState>((set) => ({
	pending: null,
	revealOperation: (command) => set({ pending: command }),
	clearReveal: () => set({ pending: null }),
}));
