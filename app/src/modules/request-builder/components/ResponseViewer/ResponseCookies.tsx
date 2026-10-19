/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseCookies Component
 *
 * Displays cookies extracted from Set-Cookie headers: one per received line,
 * or, for a response with no lines, from the folded header.
 *
 * Parsing lives in `parse-set-cookie.ts`; the three defects it fixes are
 * documented there. The visible consequence was that `attrs` had always been
 * parsed and never rendered, so Path, HttpOnly, Secure and SameSite - the
 * reason a developer opens this tab - were computed on every row and thrown
 * away. They have a column now.
 */

import { EmptyState, HeaderValue } from "@/components/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import type { HeaderLine } from "@/types/domain";
import { parseSetCookie, parseSetCookieLine, type ParsedCookie } from "./parse-set-cookie";

export interface ResponseCookiesProps {
	headers: Record<string, string>;
	/** The lines as received (issue #2460); absent for a response that has none. */
	headerLines?: HeaderLine[];
}

/**
 * One cookie per received `Set-Cookie` line. Names are case-insensitive and the
 * engine keeps the server's spelling in the lines.
 */
function cookiesFromLines(lines: HeaderLine[]): ParsedCookie[] {
	return lines
		.filter((line) => line.name.toLowerCase() === "set-cookie")
		.map((line) => parseSetCookieLine(line.value))
		.filter((cookie): cookie is ParsedCookie => cookie !== null);
}

/** The folded map entry, for a response that carries no lines. */
function cookiesFromFolded(headers: Record<string, string>): ParsedCookie[] {
	// Header names are case-insensitive; the engine has sent both spellings.
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
	return setCookie ? parseSetCookie(setCookie) : [];
}

export default function ResponseCookies({ headers, headerLines }: ResponseCookiesProps) {
	const cookies = headerLines ? cookiesFromLines(headerLines) : cookiesFromFolded(headers);

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
												className="rounded-sm surface-sunken border border-rule px-1.5 py-0.5 font-mono text-label text-muted-foreground"
											>
												<HeaderValue value={attr} />
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
