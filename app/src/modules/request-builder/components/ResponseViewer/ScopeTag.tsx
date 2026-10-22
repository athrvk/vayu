/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The level an assertion or a console line came from (issue #2522): a request
 * runs the scripts of every collection and folder it inherits, and the list
 * would otherwise read as if the request alone had written all of it.
 *
 * Neutral text, never a status tint - in the Tests list colour is the verdict,
 * and in the Console it is the `console.*` method. The request's own level
 * needs no tag, and neither does an absent scope (a trace stored before the
 * field) or a value a newer engine might add: an unlabelled row is better than
 * a wrong label.
 */

import { cn } from "@/lib/utils";
import type { ElementScope } from "@/types";

const INHERITED_LABEL: Partial<Record<ElementScope, string>> = {
	collection: "Collection",
	folder: "Folder",
};

export default function ScopeTag({
	scope,
	className,
}: {
	scope: ElementScope | undefined;
	className?: string;
}) {
	const label = scope ? INHERITED_LABEL[scope] : undefined;
	if (!label) return null;
	return (
		<span className={cn("shrink-0 text-micro text-muted-foreground", className)}>{label}</span>
	);
}
