/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared building blocks for CollectionDetail tabs.
 */

import type { ReactNode } from "react";
import { Callout } from "@/components/shared";
import { TimeValue } from "@/components/shared/TimeValue";
import { Card } from "@/components/ui/card";
import { Eyebrow } from "@/components/ui/eyebrow";

/**
 * A failed save on these tabs used to be invisible.
 *
 * Every tab calls `updateCollection.mutate(...)`, there is no global
 * `MutationCache.onError` (see lib/query-client.ts), and no tab read
 * `isError`/`error` - so a rejected save just flipped the button from "Saving…"
 * back to "Save Changes" and left the user believing it had gone through. The
 * mutation *recorded* the failure; nothing rendered it.
 *
 * `blocking`, not `warning`: nothing was written, so this is the error tier.
 */
export function SaveFailed({
	mutation,
	what,
	className,
}: {
	mutation: { isError: boolean; error: unknown };
	what: string;
	/** Spacing is the caller's - the three tabs use different layouts. */
	className?: string;
}) {
	if (!mutation.isError) return null;
	const detail = mutation.error instanceof Error ? mutation.error.message : null;
	return (
		<Callout severity="blocking" title={`Couldn't save ${what}`} className={className}>
			{detail ?? "The change was not saved. Try again."}
		</Callout>
	);
}

interface FieldProps {
	label: string;
	hint?: string;
	children: React.ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
	return (
		<div>
			<Eyebrow size="xs" className="mb-2">
				{label}
			</Eyebrow>
			{children}
			{hint && <div className="text-label text-muted-foreground mt-1">{hint}</div>}
		</div>
	);
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<Eyebrow size="xs" className="mb-2">
			{children}
		</Eyebrow>
	);
}

export function InfoBanner({ children }: { children: React.ReactNode }) {
	return (
		<Callout severity="info" className="mb-5">
			{children}
		</Callout>
	);
}

/** How long ago, with the card one hover away; a dash where the engine holds no time. */
export function RelativeTime({ value }: { value: number | string | undefined }) {
	if (value === undefined || value === "") return <>-</>;
	return <TimeValue value={value} style="relative" />;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
	return (
		<Card pad="sm" className="py-2.5">
			<Eyebrow size="xs" className="mb-1">
				{label}
			</Eyebrow>
			<div className="text-lg font-bold text-foreground font-mono">{value}</div>
		</Card>
	);
}
