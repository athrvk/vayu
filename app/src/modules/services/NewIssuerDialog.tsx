/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * NewIssuerDialog (issue #502)
 *
 * The start form for a mock OAuth 2.0 issuer. Everything here is optional
 * engine-side, so the dialog opens ready to submit: a bare start is the common
 * "I just need a token" case, and the three fields are the ones that change
 * what the tokens *are* - how long they live, what they claim, and how the
 * issuer misbehaves.
 *
 * The port is not offered. An issuer binds an ephemeral loopback port by
 * default, an explicit one that another listener holds is a `500`, and nothing
 * about a mock issuer wants a memorable port - its URLs are copied, not typed.
 * Clients are not offered either: with none configured any client id is
 * accepted, which is what a test needs; a real client list is a fixture the MCP
 * tools and the API can still supply.
 *
 * Every value is validated here before it is sent, because the engine refuses a
 * bad one with a `400 mock_issuer_invalid_config` rather than falling back to a
 * default - and an issuer running with an expiry other than the one asked for
 * would defeat the point of asking. The claims box is the one that needs it
 * most: a JSON typo is invisible until a token comes back without the claim.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useStartMockIssuerMutation } from "@/queries";
import { useToastStore } from "@/stores";
import type { MockIssuerFailureMode } from "@/types";
import {
	DEFAULT_EXPIRES_IN_SECONDS,
	DEFAULT_SLOW_MS,
	FAILURE_MODE_LABELS,
	MAX_EXPIRES_IN_SECONDS,
	MAX_SLOW_MS,
} from "./failure-modes";

export interface NewIssuerDialogProps {
	/**
	 * Mounted only while open, like `RunCollectionDialog`: the mount *is* the
	 * reset, so the fields and any engine error start clean every time rather
	 * than carrying the last attempt over or needing an effect to clear it.
	 */
	onOpenChange: (open: boolean) => void;
	/** Called with the new issuer's id, so the drawer can expand its row. */
	onStarted?: (issuerId: string) => void;
}

/**
 * Claims are a JSON *object* or nothing at all. An array or a bare scalar
 * parses cleanly and is still not a claim set, so both are named here rather
 * than sent onward to come back as an engine error the user cannot place.
 */
function parseClaims(text: string): { claims?: Record<string, unknown>; error?: string } {
	const trimmed = text.trim();
	if (trimmed === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Claims must be valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: 'Claims must be a JSON object, e.g. {"sub": "alice"}' };
	}
	return { claims: parsed as Record<string, unknown> };
}

export function NewIssuerDialog({ onOpenChange, onStarted }: NewIssuerDialogProps) {
	const showToast = useToastStore((s) => s.showToast);
	const startIssuer = useStartMockIssuerMutation();

	const [expiresIn, setExpiresIn] = useState(String(DEFAULT_EXPIRES_IN_SECONDS));
	const [failureMode, setFailureMode] = useState<MockIssuerFailureMode>("none");
	const [slowMs, setSlowMs] = useState(String(DEFAULT_SLOW_MS));
	const [claimsText, setClaimsText] = useState("");

	const expiresInValue = Number(expiresIn);
	const expiresInValid =
		Number.isInteger(expiresInValue) &&
		expiresInValue >= 1 &&
		expiresInValue <= MAX_EXPIRES_IN_SECONDS;

	const slowMsValue = Number(slowMs);
	const slowMsValid =
		failureMode !== "slow" ||
		(Number.isInteger(slowMsValue) && slowMsValue >= 0 && slowMsValue <= MAX_SLOW_MS);

	const claims = parseClaims(claimsText);
	const canStart = expiresInValid && slowMsValid && !claims.error && !startIssuer.isPending;

	const start = () => {
		if (!canStart) return;
		startIssuer.mutate(
			{
				expiresInSeconds: expiresInValue,
				failureMode,
				// Only when it means something: `slowMs` outside `slow` mode is a
				// value the issuer never reads, and sending it would put a number
				// in the row summary that nothing acts on.
				...(failureMode === "slow" ? { slowMs: slowMsValue } : {}),
				...(claims.claims ? { claims: claims.claims } : {}),
			},
			{
				onSuccess: (issuer) => {
					onStarted?.(issuer.issuerId);
					showToast("Mock issuer started", "success");
					onOpenChange(false);
				},
			}
		);
	};

	const engineError = startIssuer.error;

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New OAuth issuer</DialogTitle>
					<DialogDescription>
						A local issuer that mints signed tokens on demand - point a request&apos;s
						OAuth 2.0 config at its token URL and no external identity provider is
						involved.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					{/* The bound in words, not only in `aria-invalid` and a disabled
					    button. A field that reddens while Start greys out states
					    that something is wrong and never which field or why - and
					    `aria-invalid` alone announces "invalid" with no correction.
					    The claims box below already did this; the two numbers did
					    not. */}
					<div className="space-y-1">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="new-issuer-expiry" className="leading-snug">
								Token lifetime
								<span className="block text-xs font-normal text-muted-foreground">
									Seconds. What `exp` is stamped with, and what `expires_in`
									reports.
								</span>
							</Label>
							<Input
								id="new-issuer-expiry"
								type="number"
								min={1}
								max={MAX_EXPIRES_IN_SECONDS}
								step={1}
								value={expiresIn}
								onChange={(e) => setExpiresIn(e.target.value)}
								className="w-28 shrink-0"
								aria-invalid={!expiresInValid}
								aria-describedby={
									expiresInValid ? undefined : "new-issuer-expiry-error"
								}
							/>
						</div>
						{!expiresInValid && (
							<p
								id="new-issuer-expiry-error"
								className="text-xs text-destructive-text"
							>
								{`A whole number of seconds, 1 to ${MAX_EXPIRES_IN_SECONDS}.`}
							</p>
						)}
					</div>

					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="new-issuer-failure-mode" className="leading-snug">
							Failure mode
							<span className="block text-xs font-normal text-muted-foreground">
								How `/token` answers. Changeable while the issuer runs.
							</span>
						</Label>
						<Select
							value={failureMode}
							onValueChange={(value) =>
								setFailureMode(value as MockIssuerFailureMode)
							}
						>
							<SelectTrigger id="new-issuer-failure-mode" className="w-40 shrink-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(FAILURE_MODE_LABELS).map(([mode, label]) => (
									<SelectItem key={mode} value={mode}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{failureMode === "slow" && (
						<div className="space-y-1">
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="new-issuer-slow" className="leading-snug">
									Delay
									<span className="block text-xs font-normal text-muted-foreground">
										Milliseconds to wait before answering normally.
									</span>
								</Label>
								<Input
									id="new-issuer-slow"
									type="number"
									min={0}
									max={MAX_SLOW_MS}
									step={100}
									value={slowMs}
									onChange={(e) => setSlowMs(e.target.value)}
									className="w-28 shrink-0"
									aria-invalid={!slowMsValid}
									aria-describedby={
										slowMsValid ? undefined : "new-issuer-slow-error"
									}
								/>
							</div>
							{!slowMsValid && (
								<p
									id="new-issuer-slow-error"
									className="text-xs text-destructive-text"
								>
									{`A whole number of milliseconds, 0 to ${MAX_SLOW_MS}.`}
								</p>
							)}
						</div>
					)}

					<div className="space-y-1">
						<Label htmlFor="new-issuer-claims" className="leading-snug">
							Claims
							<span className="block text-xs font-normal text-muted-foreground">
								JSON merged into every token. `iss`, `iat`, `exp` and `jti` are the
								issuer&apos;s own and always win.
							</span>
						</Label>
						<Textarea
							id="new-issuer-claims"
							rows={4}
							placeholder={'{ "sub": "alice", "roles": ["admin"] }'}
							value={claimsText}
							onChange={(e) => setClaimsText(e.target.value)}
							className="font-mono text-xs"
							aria-invalid={!!claims.error}
							aria-describedby={claims.error ? "new-issuer-claims-error" : undefined}
						/>
						{claims.error && (
							<p
								id="new-issuer-claims-error"
								className="text-xs text-destructive-text"
							>
								{claims.error}
							</p>
						)}
					</div>

					{/* The engine's own refusal, shown where the field that caused it
					    is - a toast would take the message away from the form the
					    user has to correct. */}
					{engineError && (
						<Callout severity="blocking" title="Could not start the issuer">
							{engineError instanceof Error ? engineError.message : "Unknown error"}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={start} disabled={!canStart}>
						{startIssuer.isPending && (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
						)}
						Start issuer
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
