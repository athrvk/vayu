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
 * A redirect chain is two groups (issue #2461). The final response's headers
 * are all `headers` holds, so a cookie a followed 3xx set - the `302` that
 * answers a login - is read from `redirects` instead and listed under
 * "Set during redirects", one sub-heading per hop. Those rows say what the
 * server sent, never that the jar stored it: a cross-origin hop's cookie is
 * dropped by curl, so "stored" would be a claim this tab cannot back.
 *
 * A hop that went from `https` to `http` (`schemeDowngrade`, issue #2949) is
 * announced above both groups whether or not it set a cookie: the common
 * downgrade is a bare `301` with nothing to list, and this tab is the only
 * reader of the hops.
 *
 * Parsing lives in `parse-set-cookie.ts`; the three defects it fixes are
 * documented there. The visible consequence was that `attrs` had always been
 * parsed and never rendered, so Path, HttpOnly, Secure and SameSite - the
 * reason a developer opens this tab - were computed on every row and thrown
 * away. They have a column now.
 */

import { Callout, EmptyState, HeaderValue } from "@/components/shared";
import {
	Eyebrow,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import type { HeaderLine, RedirectHop } from "@/types/domain";
import { parseSetCookie, parseSetCookieLine, type ParsedCookie } from "./parse-set-cookie";

export interface ResponseCookiesProps {
	headers: Record<string, string>;
	/** The lines as received (issue #2460); absent for a response that has none. */
	headerLines?: HeaderLine[];
	/** The redirect hops followed before this response (issue #2461); absent when none were. */
	redirects?: RedirectHop[];
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

interface HopCookies {
	/** "302 Found, to /home": what answered, and where it sent the client. */
	label: string;
	cookies: ParsedCookie[];
}

/**
 * "302 Found, to /home": what answered and where it sent the client. `url` is
 * the request the hop answered, resolved by libcurl; the `Location` beside it
 * may be relative. A hop from an engine before #2949 has no `url`.
 */
function hopLabel(hop: RedirectHop): string {
	const location = hop.headerLines.find((line) => line.name.toLowerCase() === "location");
	const answer = `${hop.status} ${hop.statusText}`.trim();
	const from = hop.url ? `${answer} from ${hop.url}` : answer;
	return location?.value ? `${from}, to ${location.value}` : from;
}

function DowngradeNotice({ hops }: { hops: RedirectHop[] }) {
	return (
		<Callout severity="warning" title="Redirected from https to http">
			The next request went out in clear text. Authorization and Cookie are withheld on this
			change; an API key sent as a header is not.
			<ul className="mt-1.5 space-y-0.5 font-mono break-all">
				{hops.map((hop, i) => (
					<li key={i}>{hopLabel(hop)}</li>
				))}
			</ul>
		</Callout>
	);
}

/** The hops that set a cookie, in the order they arrived; a hop that set none has nothing to list. */
function hopsWithCookies(redirects: RedirectHop[] | undefined): HopCookies[] {
	return (redirects ?? [])
		.map((hop) => ({ label: hopLabel(hop), cookies: cookiesFromLines(hop.headerLines) }))
		.filter((hop) => hop.cookies.length > 0);
}

function CookieTable({ cookies }: { cookies: ParsedCookie[] }) {
	return (
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
	);
}

export default function ResponseCookies({ headers, headerLines, redirects }: ResponseCookiesProps) {
	const cookies = headerLines ? cookiesFromLines(headerLines) : cookiesFromFolded(headers);
	const hops = hopsWithCookies(redirects);
	const downgrades = (redirects ?? []).filter((hop) => hop.schemeDowngrade === true);
	const noCookies = cookies.length === 0 && hops.length === 0;

	if (noCookies && downgrades.length === 0) {
		return <EmptyState variant="inline" title="No cookies in response" />;
	}

	// A response with no redirect cookies is the one table it always was; the
	// group labels appear only when there is a second group to tell it from.
	const grouped = hops.length > 0;

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
		<div className="p-4 overflow-auto h-full space-y-6">
			{downgrades.length > 0 && <DowngradeNotice hops={downgrades} />}
			{noCookies && <EmptyState variant="inline" title="No cookies in response" />}
			{cookies.length > 0 && (
				<section className="space-y-2">
					{grouped && <Eyebrow>Set by this response</Eyebrow>}
					<CookieTable cookies={cookies} />
				</section>
			)}
			{grouped && (
				<section className="space-y-4">
					<Eyebrow>Set during redirects</Eyebrow>
					{hops.map((hop, i) => (
						<div key={i} className="space-y-2">
							<p className="font-mono text-sm break-all text-foreground">
								{hop.label}
							</p>
							<CookieTable cookies={hop.cookies} />
						</div>
					))}
				</section>
			)}
		</div>
	);
}
