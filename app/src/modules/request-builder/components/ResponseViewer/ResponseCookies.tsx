/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cookies from Set-Cookie headers: one per received line, or from the folded header when there are
 * no lines. A redirect chain is two groups (#2461): `headers` holds only the final response's, so a
 * cookie a followed 3xx set (the `302` answering a login) is read from `redirects` and listed under
 * "Set during redirects", one sub-heading per hop. Those rows say what the server sent, never that
 * the jar stored it: curl drops a cross-origin hop's cookie. An `https` to `http` hop
 * (`schemeDowngrade`, #2949) is announced above both groups whether or not it set a cookie: the
 * common downgrade is a bare `301`, and this tab is the hops' only reader. Parsing is
 * `parse-set-cookie.ts`; the attributes (Path, HttpOnly, Secure, SameSite), the reason a developer
 * opens this tab, have their own column.
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
 * One cookie per received `Set-Cookie` line; names are case-insensitive, and the lines keep the
 * server's spelling.
 */
function cookiesFromLines(lines: HeaderLine[]): ParsedCookie[] {
	return lines
		.filter((line) => line.name.toLowerCase() === "set-cookie")
		.map((line) => parseSetCookieLine(line.value))
		.filter((cookie): cookie is ParsedCookie => cookie !== null);
}

/** The folded map entry, for a response that carries no lines. */
function cookiesFromFolded(headers: Record<string, string>): ParsedCookie[] {
	// Header names are case-insensitive, and the engine has sent both spellings.
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
	return setCookie ? parseSetCookie(setCookie) : [];
}

interface HopCookies {
	/** "302 Found, to /home": what answered, and where it sent the client. */
	label: string;
	cookies: ParsedCookie[];
}

/**
 * "302 Found, to /home": what answered and where it sent the client. `url` is the request the hop
 * answered, engine-resolved; the `Location` beside it may be relative. Engines before #2949 send no
 * `url`.
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

	// Without redirect cookies it is one table; group labels appear only when a second group
	// exists.
	const grouped = hops.length > 0;

	return (
		/*
		 * Both rules are `border-rule`, resolved by the pane's `surface-card`; `border-border`
		 * measured 1.003 and 1.002 on a card, so in dark the list had no visible structure. The
		 * rows are not a step lighter than the header (here that lands back at invisible): the
		 * header is told apart by its label styling, and rows light up on hover.
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
