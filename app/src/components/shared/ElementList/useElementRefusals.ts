/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which element the engine refused on save, and why (#3043), for the host to
 * hand `ElementList` as `errors`.
 *
 * The engine names a refused element by its 1-based position in the array it
 * was sent (`parseElementRefusal`), so a host records the refusal against the
 * array it sent and this keeps it against that element's *object*: the refusal
 * shows while the row still holds the element the engine judged, and ends the
 * moment the user edits it (an edit makes a new object), with no clear call to
 * forget. A refusal that does not read as one leaves what is recorded alone -
 * the host's own failure report is then all there is.
 */

import { useCallback, useMemo, useState } from "react";
import { parseElementRefusal } from "@/lib/elements";
import { ApiError } from "@/services/http-client";
import type { ElementDef } from "@/types";

/** Element id to the engine's problem with it, for the rows that carry one. */
export type ElementErrors = Readonly<Record<string, string>>;

interface Refusal {
	element: ElementDef;
	problem: string;
}

const NO_ERRORS: ElementErrors = {};

export function useElementRefusals(elements: readonly ElementDef[]): {
	errors: ElementErrors;
	/** Record what a failed save of `sent` says about one of its elements, if it says. */
	refuse: (error: unknown, sent: readonly ElementDef[]) => void;
} {
	const [refusal, setRefusal] = useState<Refusal | null>(null);

	const refuse = useCallback((error: unknown, sent: readonly ElementDef[]) => {
		if (!(error instanceof ApiError) || error.statusCode !== 400) return;
		const found = parseElementRefusal(error.message, sent);
		if (found) setRefusal(found);
	}, []);

	const errors = useMemo<ElementErrors>(() => {
		if (!refusal || !elements.includes(refusal.element)) return NO_ERRORS;
		return { [refusal.element.id]: refusal.problem };
	}, [refusal, elements]);

	return { errors, refuse };
}
