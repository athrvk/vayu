/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MethodSelector Component
 *
 * HTTP method dropdown with color coding
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context";
import type { HttpMethod } from "@/types";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const METHOD_COLORS: Record<HttpMethod, string> = {
	GET: "method-get",
	POST: "method-post",
	PUT: "method-put",
	PATCH: "method-patch",
	DELETE: "method-delete",
	HEAD: "method-head",
	OPTIONS: "method-options",
};

export default function MethodSelector() {
	const { request, updateField } = useRequestBuilderContext();

	return (
		<Select
			value={request.method}
			onValueChange={(value) => updateField("method", value as HttpMethod)}
		>
			<SelectTrigger
				className={cn(
					"w-[76px] h-[34px] font-mono font-bold text-[11px] bg-accent border-border",
					METHOD_COLORS[request.method]
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{HTTP_METHODS.map((method) => (
					<SelectItem
						key={method}
						value={method}
						className={cn("font-mono font-semibold", METHOD_COLORS[method])}
					>
						{method}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
