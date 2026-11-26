/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The level an assertion or console line came from (#2522): a request runs the scripts of every
 * collection it inherits, and the list would otherwise read as the request's alone. Neutral text,
 * never a status tint: in Tests colour is the verdict, in Console the `console.*` method. No tag
 * for the request's own level, an absent scope (an older trace), or a value a newer engine adds: no
 * label beats a wrong one.
 */

import { cn } from "@/lib/utils";
import type { ElementScope } from "@/types";

const INHERITED_LABEL: Partial<Record<ElementScope, string>> = {
	collection: "Collection",
	folder: "Nested collection",
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
