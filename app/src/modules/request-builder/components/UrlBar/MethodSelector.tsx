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
	GET: "text-green-600",
	POST: "text-yellow-600",
	PUT: "text-blue-600",
	PATCH: "text-purple-600",
	DELETE: "text-red-600",
	HEAD: "text-gray-600",
	OPTIONS: "text-gray-600",
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
					"w-28 font-mono font-semibold text-sm",
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
