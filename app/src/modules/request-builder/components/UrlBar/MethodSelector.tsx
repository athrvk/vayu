
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
	GET: "text-[#22c55e]",
	POST: "text-[#3b82f6]",
	PUT: "text-[#f59e0b]",
	PATCH: "text-[#a855f7]",
	DELETE: "text-[#ef4444]",
	HEAD: "text-[#06b6d4]",
	OPTIONS: "text-[#6b7280]",
};

export default function MethodSelector() {
	const { request, updateField } = useRequestBuilderContext();

	return (
		<Select
			value={request.method}
			onValueChange={(value) => updateField("method", value as HttpMethod)}
		>
			<SelectTrigger
				className={cn("w-[76px] h-[34px] font-mono font-bold text-[11px] bg-accent border-border", METHOD_COLORS[request.method])}
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
