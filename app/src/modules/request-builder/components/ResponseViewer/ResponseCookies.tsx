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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
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
		 * Both rules are `border-rule`, resolved by the `surface-card` the
		 * response pane declares. They were `border-border` and
		 * `border-border/50`, which on a card measure 1.003 and 1.002 - the
		 * cookie list had no visible structure whatsoever in dark mode: header
		 * and rows ran together as one block of text.
		 *
		 * The rows are not held one step lighter than the header, because at this
		 * surface "one step lighter" lands back at invisible. The header is
		 * distinguished by its label styling instead, and rows still light up on
		 * hover.
		 */
		<div className="p-4 overflow-auto h-full">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Value</TableHead>
						<TableHead>Attributes</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{cookies.map((cookie, i) => (
						<TableRow key={i}>
							<TableCell className="font-mono text-muted-foreground">
								{cookie.name}
							</TableCell>
							<TableCell className="font-mono break-all text-foreground">
								{cookie.value}
							</TableCell>
							<TableCell>
								{cookie.attrs.length > 0 ? (
									<div className="flex flex-wrap gap-1">
										{cookie.attrs.map((attr, j) => (
											<span
												key={j}
												className="rounded-sm surface-sunken border border-rule px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
											>
												{attr}
											</span>
										))}
									</div>
								) : (
									<span className="text-muted-foreground italic">none</span>
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
