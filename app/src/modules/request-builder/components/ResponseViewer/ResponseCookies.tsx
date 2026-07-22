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
 *
 * Parsing lives in `parse-set-cookie.ts`; the three defects it fixes are
 * documented there. The visible consequence was that `attrs` had always been
 * parsed and never rendered, so Path, HttpOnly, Secure and SameSite - the
 * reason a developer opens this tab - were computed on every row and thrown
 * away. They have a column now.
 */

import { EmptyState } from "@/components/shared";
import { parseSetCookie } from "./parse-set-cookie";

export interface ResponseCookiesProps {
	headers: Record<string, string>;
}

export default function ResponseCookies({ headers }: ResponseCookiesProps) {
	// Header names are case-insensitive; the engine has sent both spellings.
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
	const cookies = setCookie ? parseSetCookie(setCookie) : [];

	if (cookies.length === 0) {
		return <EmptyState variant="inline" title="No cookies in response" />;
	}

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
					<tr className="border-b border-rule">
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Name
						</th>
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Value
						</th>
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Attributes
						</th>
					</tr>
				</thead>
				<tbody>
					{cookies.map((cookie, i) => (
						<tr key={i} className="border-b border-rule hover:bg-muted/50">
							<td className="py-2 px-3 font-mono text-primary align-top">
								{cookie.name}
							</td>
							<td className="py-2 px-3 font-mono break-all align-top">
								{cookie.value}
							</td>
							<td className="py-2 px-3 align-top">
								{cookie.attrs.length > 0 ? (
									<div className="flex flex-wrap gap-1">
										{cookie.attrs.map((attr, j) => (
											<span
												key={j}
												className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
											>
												{attr}
											</span>
										))}
									</div>
								) : (
									<span className="text-muted-foreground italic text-xs">
										none
									</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
