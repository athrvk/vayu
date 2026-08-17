/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 *
 * The start form for a mock server's two injection knobs (issue #570), on the
 * shape of `services/NewIssuerDialog` - the precedent for "a service with
 * options, started from a form".
 *
 * It is the *secondary* affordance, not the way in: the common case is "serve
 * this collection with nothing set", and the header's button still does that in
 * one click. Latency and error rate matter to the run you point at the mock -
 * one is what makes a load-run baseline realistic rather than degenerate, the
 * other is how a run's error handling and threshold verdict get exercised
 * without breaking a real service - and neither is what you want on the way to
 * poking a route by hand.
 *
 * Both are start-time only. The engine has no `PUT /mock/:id`, and this did not
 * add one: they are read per response, so they *could* be live, but a run
 * against a mock has to be able to say which configuration produced its
 * numbers, which is the same reason the route table is a start-time snapshot.
 * Stop and start to change one - and the stop tooltip says so.
 *
 * The mutation lives in `MockServerControl`, not here: it owns the success
 * toast and the started/running switch either way, and a second copy of the
 * start call is a second place for the two to drift.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import {
	DEFAULT_MOCK_OPTIONS,
	MAX_MOCK_ERROR_RATE_PCT,
	MAX_MOCK_LATENCY_MS,
	outOfRange,
	type MockServerOptions,
} from "./mock-server-options";

export interface StartMockServerDialogProps {
	/**
	 * Mounted only while open, like `NewIssuerDialog`: the mount *is* the reset,
	 * so the fields start at the defaults every time rather than carrying the
	 * last attempt over.
	 */
	onOpenChange: (open: boolean) => void;
	/** Start with these. The caller closes the dialog once the engine answers. */
	onStart: (options: MockServerOptions) => void;
	/** The caller's start mutation, so the footer can say it is in flight. */
	pending: boolean;
	/** The engine's refusal, shown here rather than behind the dialog. */
	error: Error | null;
}

export function StartMockServerDialog({
	onOpenChange,
	onStart,
	pending,
	error,
}: StartMockServerDialogProps) {
	const [latency, setLatency] = useState(String(DEFAULT_MOCK_OPTIONS.latencyMs));
	const [errorRate, setErrorRate] = useState(String(DEFAULT_MOCK_OPTIONS.errorRatePct));

	const latencyError = outOfRange(latency, MAX_MOCK_LATENCY_MS, "milliseconds");
	const errorRateError = outOfRange(errorRate, MAX_MOCK_ERROR_RATE_PCT, "percent");
	const canStart = !latencyError && !errorRateError && !pending;

	const start = () => {
		if (!canStart) return;
		onStart({ latencyMs: Number(latency), errorRatePct: Number(errorRate) });
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Mock server options</DialogTitle>
					<DialogDescription>
						What the mock does on its way to answering. Both are fixed for the life of
						the mock - stop and start it to change either.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					{/* The bound in words, not only in `aria-invalid` and a disabled
					    button: a field that reddens while Start greys out states that
					    something is wrong and never which field or why. */}
					<div className="space-y-1">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="mock-latency" className="leading-snug">
								Latency
								<span className="block text-xs font-normal text-muted-foreground">
									Milliseconds to wait before every answer. A baseline with no
									latency at all is not one a real service can be read against.
								</span>
							</Label>
							<Input
								id="mock-latency"
								type="number"
								min={0}
								max={MAX_MOCK_LATENCY_MS}
								step={50}
								value={latency}
								onChange={(e) => setLatency(e.target.value)}
								className="w-28 shrink-0"
								aria-invalid={!!latencyError}
								aria-describedby={latencyError ? "mock-latency-error" : undefined}
							/>
						</div>
						{latencyError && (
							<p id="mock-latency-error" className="text-xs text-destructive-text">
								{latencyError}
							</p>
						)}
					</div>

					<div className="space-y-1">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="mock-error-rate" className="leading-snug">
								Error rate
								<span className="block text-xs font-normal text-muted-foreground">
									Percent of answers replaced by a 500, so a run&apos;s error
									handling and threshold verdict get exercised without breaking a
									real service.
								</span>
							</Label>
							<Input
								id="mock-error-rate"
								type="number"
								min={0}
								max={MAX_MOCK_ERROR_RATE_PCT}
								step={1}
								value={errorRate}
								onChange={(e) => setErrorRate(e.target.value)}
								className="w-28 shrink-0"
								aria-invalid={!!errorRateError}
								aria-describedby={
									errorRateError ? "mock-error-rate-error" : undefined
								}
							/>
						</div>
						{errorRateError && (
							<p id="mock-error-rate-error" className="text-xs text-destructive-text">
								{errorRateError}
							</p>
						)}
					</div>

					{/* The engine's own refusal - a collection with nothing to serve,
					    or the server budget - shown where the form is rather than as a
					    toast behind an open dialog. */}
					{error && (
						<Callout severity="blocking" title="Could not start the mock server">
							{error.message}
						</Callout>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={start} disabled={!canStart}>
						{pending && (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
						)}
						Start mock server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
