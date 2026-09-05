/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared building blocks for CollectionDetail tabs.
 */

import { Info } from "lucide-react";
import { Button } from "@/components/ui";
import { Callout } from "@/components/shared";

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

/**
 * A background change that arrived while a draft was dirty - see
 * `useEntityDraft`'s `externalValue`. The tab never overwrites the
 * in-progress edit; this is what it shows instead, with a "Take theirs"
 * action that adopts the external value.
 */
export function ExternalChangeCallout({
	what,
	onTakeTheirs,
	className,
}: {
	/** Named in the title, e.g. "name", "description", "the script", "auth". */
	what: string;
	onTakeTheirs: () => void;
	/** Spacing is the caller's - see `SaveFailed` above. */
	className?: string;
}) {
	return (
		<Callout
			severity="warning"
			title={`Changed elsewhere: ${what}`}
			className={className}
			action={
				<Button variant="outline" size="sm" onClick={onTakeTheirs}>
					Take theirs
				</Button>
			}
		>
			Someone else changed this while you were editing. Your edit is kept until you choose.
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
			<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
				{label}
			</div>
			{children}
			{hint && <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>}
		</div>
	);
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
			{children}
		</div>
	);
}

export function InfoBanner({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-start gap-2 p-2.5 px-3 rounded-md mb-5 bg-primary/10 border border-primary/30">
			<Info className="w-3.5 h-3.5 text-primary shrink-0 mt-px" />
			<p className="text-xs text-foreground leading-relaxed m-0">{children}</p>
		</div>
	);
}

export function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-card border border-border rounded-md px-3.5 py-2.5">
			<div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1">
				{label}
			</div>
			<div className="text-lg font-bold text-foreground font-mono">{value}</div>
		</div>
	);
}

export function ComingSoon({ label }: { label: string }) {
	return (
		<div className="max-w-[540px] rounded-md border border-dashed border-border bg-panel/40 p-8 text-center">
			<div className="text-sm font-medium text-foreground">{label}</div>
			<div className="text-xs text-muted-foreground mt-1">Coming soon.</div>
		</div>
	);
}
