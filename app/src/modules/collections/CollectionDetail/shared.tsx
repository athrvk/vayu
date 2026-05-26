
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
			{hint && <div className="text-[11px] text-subtle-foreground mt-1">{hint}</div>}
		</div>
	);
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground mb-2">
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

export function formatRelative(iso: string | undefined): string {
	if (!iso) return "—";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "—";
	const diffMs = Date.now() - then;
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.floor(mo / 12)}y ago`;
}
