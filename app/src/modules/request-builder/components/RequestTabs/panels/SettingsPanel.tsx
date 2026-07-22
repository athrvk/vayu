/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SettingsPanel Component
 *
 * Per-request execution settings. Today that is the redirect policy: the engine
 * has always accepted `followRedirects` / `maxRedirects` and defaulted to
 * following, but nothing in the app sent them, so a 3xx was followed silently
 * and never reached the response pane. Both fields are stored on the request and
 * sent on every Send and every load test.
 *
 * `verifySSL` is deliberately not exposed here - it weakens transport security
 * and was deferred.
 */

import { Input, Label, Switch } from "@/components/ui";
import { DEFAULT_MAX_REDIRECTS, MAX_MAX_REDIRECTS, MIN_MAX_REDIRECTS } from "@/constants/request";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../../context";

const FOLLOW_LABEL = "Follow redirects";
const MAX_LABEL = "Maximum redirects";

export default function SettingsPanel() {
	const { request, updateField } = useRequestBuilderContext();
	const followRedirects = request.followRedirects;

	/**
	 * Keep the stored value inside the range the engine clamps to. An empty
	 * field would coerce to NaN, so it falls back to the default rather than
	 * writing a broken number into the request.
	 */
	const handleMaxRedirectsChange = (raw: string) => {
		if (raw === "") {
			updateField("maxRedirects", DEFAULT_MAX_REDIRECTS);
			return;
		}
		const parsed = Number.parseInt(raw, 10);
		if (Number.isNaN(parsed)) return;
		updateField(
			"maxRedirects",
			Math.min(MAX_MAX_REDIRECTS, Math.max(MIN_MAX_REDIRECTS, parsed))
		);
	};

	return (
		<div className="space-y-6 max-w-xl">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Redirects</h3>
				<p className="text-xs text-muted-foreground">
					How this request handles a 3xx response. Applies to Send and to load tests.
				</p>
			</div>

			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<Label htmlFor="setting-follow-redirects" className="text-sm font-medium">
						{FOLLOW_LABEL}
					</Label>
					<p className="text-xs text-muted-foreground mt-0.5">
						Off shows the 3xx itself - its status and <code>Location</code> header -
						instead of the page it points at.
					</p>
				</div>
				{/*
				 * Radix renders a button, not an input, so the visible <Label>
				 * does not name it on its own - aria-label does. The id is still
				 * set so the label's htmlFor click target resolves.
				 */}
				<Switch
					id="setting-follow-redirects"
					checked={followRedirects}
					onCheckedChange={(checked) => updateField("followRedirects", checked)}
					aria-label={FOLLOW_LABEL}
				/>
			</div>

			<div className="space-y-1.5">
				<Label
					htmlFor="setting-max-redirects"
					className={cn(
						"text-sm font-medium",
						!followRedirects && "text-muted-foreground"
					)}
				>
					{MAX_LABEL}
				</Label>
				<Input
					id="setting-max-redirects"
					type="number"
					inputMode="numeric"
					min={MIN_MAX_REDIRECTS}
					max={MAX_MAX_REDIRECTS}
					value={request.maxRedirects}
					onChange={(e) => handleMaxRedirectsChange(e.target.value)}
					disabled={!followRedirects}
					aria-describedby="setting-max-redirects-hint"
					className="h-9 w-32 text-[13px]"
				/>
				<p id="setting-max-redirects-hint" className="text-xs text-muted-foreground">
					{followRedirects
						? `Hops to follow before giving up (${MIN_MAX_REDIRECTS}-${MAX_MAX_REDIRECTS}). Default ${DEFAULT_MAX_REDIRECTS}.`
						: "Only applies while Follow redirects is on."}
				</p>
			</div>
		</div>
	);
}
