/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseCookies Component
 *
 * Displays cookies extracted from Set-Cookie headers.
 */

import { EmptyState } from "@/components/shared";

export interface ResponseCookiesProps {
	headers: Record<string, string>;
}

export default function ResponseCookies({ headers }: ResponseCookiesProps) {
	// Extract cookies from Set-Cookie header
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];

	if (!setCookie) {
		return <EmptyState variant="inline" title="No cookies in response" />;
	}

	// Parse cookies (simplified)
	const cookies = setCookie.split(",").map((cookie) => {
		const [nameValue, ...attrs] = cookie.split(";");
		const [name, value] = nameValue.split("=");
		return { name: name?.trim(), value: value?.trim(), attrs: attrs.join(";") };
	});

	return (
		/*
		 * Both rules are `border-border-strong`. The table lives inside
		 * `ResponseViewer`'s `bg-card`, where `--border` measures 1.003 - and the
		 * row rule was `border-border/50`, which composites to 1.002. The cookie
		 * list had no visible structure whatsoever in dark mode: header and rows
		 * ran together as one block of text.
		 *
		 * The rows are not held one step lighter than the header, because at this
		 * surface "one step lighter" lands back at invisible. The header is
		 * distinguished by its label styling instead, and rows still light up on
		 * hover.
		 */
		<div className="p-4 overflow-auto h-full">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border-strong">
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Name
						</th>
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Value
						</th>
					</tr>
				</thead>
				<tbody>
					{cookies.map((cookie, i) => (
						<tr key={i} className="border-b border-border-strong hover:bg-muted/50">
							<td className="py-2 px-3 font-mono text-primary">{cookie.name}</td>
							<td className="py-2 px-3 font-mono break-all">{cookie.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
