/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * CookiesCard
 *
 * What the engine's cookie jar is holding, and the button that empties it
 * (issue #301). The jar is what makes "log in once, reuse the session" work
 * for design-mode requests, and it is kept per environment - so this is also
 * where a user confirms that a staging session is not about to ride along on a
 * production call.
 *
 * A session the user cannot see or reset is a support problem: "why is this
 * request already authenticated" has no answer without a list, and a stale
 * session that breaks a call has no fix without a clear button. Both live
 * here, beside the run-history data controls in General for the same reason -
 * this is engine-held state the user did not type.
 */

import { useState } from "react";
import { Cookie, Loader2 } from "lucide-react";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	DeleteConfirmDialog,
} from "@/components/ui";
import { useCookiesQuery, useClearCookiesMutation, useEnvironmentsQuery } from "@/queries";
import { useToastStore } from "@/stores";
import type { CookieScope } from "@/types";

/** What a scope is called once its id is resolved against the environments. */
function scopeLabel(
	scope: CookieScope,
	environmentName: (id: string) => string | undefined
): string {
	if (scope.environmentId === null) return "No environment";
	// A jar can outlive the environment it belongs to - the engine keys on the
	// id and never hears about a delete. Showing the raw id then is honest and
	// still clearable, which "Unknown" would not be.
	return environmentName(scope.environmentId) ?? scope.environmentId;
}

/**
 * When the cookie stops being sent. `expires: 0` is the engine's session
 * sentinel - it dies with the engine process, which is a materially different
 * promise from a date and reads as one here.
 */
function expiryLabel(expires: number): string {
	if (expires === 0) return "Session";
	return new Date(expires * 1000).toLocaleString();
}

export function CookiesCard() {
	const { data, isError } = useCookiesQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const clearCookies = useClearCookiesMutation();
	const showToast = useToastStore((s) => s.showToast);
	// The scope awaiting confirmation, or "all"; null when no dialog is open.
	// `undefined` cannot be the idle value here - it is a legitimate scope
	// (clear everything), which is exactly the distinction the engine draws.
	const [confirming, setConfirming] = useState<CookieScope | "all" | null>(null);

	const scopes = data?.scopes ?? [];
	const total = scopes.reduce((sum, scope) => sum + scope.cookies.length, 0);
	const environmentName = (id: string) => environments.find((env) => env.id === id)?.name;

	const clear = async (target: CookieScope | "all") => {
		setConfirming(null);
		try {
			const result = await clearCookies.mutateAsync(
				target === "all" ? undefined : { environmentId: target.environmentId }
			);
			showToast(
				`Cleared ${result.cleared} cookie${result.cleared === 1 ? "" : "s"}`,
				"success"
			);
		} catch {
			showToast("Could not clear cookies", "error");
		}
	};

	return (
		<Card data-setting-anchor="cookies">
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<Cookie className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">Cookies</CardTitle>
				</div>
				<CardDescription>
					Cookies the engine stores while you send requests, so a session survives to the
					next one. Kept per environment and only in memory - they are gone when Vayu
					closes, and load tests never use them.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isError ? (
					<p className="text-sm text-muted-foreground">
						The engine did not answer, so what it is holding is unknown.
					</p>
				) : total === 0 ? (
					<p className="text-sm text-muted-foreground">No cookies stored.</p>
				) : (
					<>
						<div className="flex items-center justify-between gap-4">
							<p className="text-sm text-muted-foreground">
								{total} cookie{total === 1 ? "" : "s"} across {scopes.length}{" "}
								{scopes.length === 1 ? "environment" : "environments"}.
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setConfirming("all")}
								disabled={clearCookies.isPending}
								className="text-destructive-text hover:bg-destructive-text/10 hover:text-destructive-text"
							>
								{clearCookies.isPending ? (
									<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
								) : (
									<Cookie className="w-4 h-4 mr-1.5" />
								)}
								Clear all cookies
							</Button>
						</div>

						{scopes.map((scope) => (
							<div
								key={scope.environmentId ?? ""}
								className="rounded-md border border-rule surface-sunken p-3 space-y-2"
							>
								<div className="flex items-center justify-between gap-4">
									<span className="text-sm font-medium text-foreground">
										{scopeLabel(scope, environmentName)}
									</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setConfirming(scope)}
										disabled={clearCookies.isPending}
									>
										Clear
									</Button>
								</div>
								{scope.cookies.map((cookie) => (
									<div
										key={`${cookie.domain}${cookie.path}${cookie.name}`}
										className="flex items-center gap-2 text-xs"
									>
										<span className="font-mono text-foreground">
											{cookie.name}
										</span>
										{/* The value, because "which session is this request
										    actually using" is the question the card exists to
										    answer and a name alone cannot. Truncated, not
										    withheld - the response viewer already shows
										    Set-Cookie in full. */}
										<span
											className="font-mono text-muted-foreground truncate max-w-[12rem]"
											title={cookie.value}
										>
											{cookie.value}
										</span>
										<span className="font-mono text-muted-foreground truncate">
											{cookie.domain}
											{cookie.path}
										</span>
										{cookie.secure && (
											<Badge variant="chip" className="text-muted-foreground">
												Secure
											</Badge>
										)}
										{cookie.httpOnly && (
											<Badge variant="chip" className="text-muted-foreground">
												HttpOnly
											</Badge>
										)}
										<span className="ml-auto text-muted-foreground whitespace-nowrap">
											{expiryLabel(cookie.expires)}
										</span>
									</div>
								))}
							</div>
						))}
					</>
				)}
			</CardContent>

			<DeleteConfirmDialog
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open) setConfirming(null);
				}}
				title={confirming === "all" ? "Clear all cookies?" : "Clear these cookies?"}
				description={
					confirming === "all"
						? "Every stored session is dropped. Requests that relied on one will need to sign in again."
						: `Cookies stored for ${confirming ? scopeLabel(confirming, environmentName) : ""} are dropped. Requests that relied on one will need to sign in again.`
				}
				onConfirm={() => {
					if (confirming !== null) void clear(confirming);
				}}
				confirmLabel="Clear"
				isDeleting={clearCookies.isPending}
			/>
		</Card>
	);
}
