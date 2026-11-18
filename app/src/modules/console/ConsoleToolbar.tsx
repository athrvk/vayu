/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The session Console's controls (#3634): the type and level filters, the
 * search box and Clear. The filters are the tab's own state, a way of looking
 * at the list; Clear empties the ring and touches nothing in History.
 */

import { Eraser, Search } from "lucide-react";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { useConsoleStore } from "@/stores/console-store";
import type { ConsoleFilter, ConsoleLevelFilter, ConsoleTypeFilter } from "./console-filter";

const TYPE_OPTIONS: { value: ConsoleTypeFilter; label: string }[] = [
	{ value: "all", label: "All types" },
	{ value: "requests", label: "Requests" },
	{ value: "scriptRequests", label: "Script requests" },
	{ value: "lines", label: "Console lines" },
];

const LEVEL_OPTIONS: { value: ConsoleLevelFilter; label: string }[] = [
	{ value: "all", label: "All levels" },
	{ value: "log", label: "Log" },
	{ value: "info", label: "Info" },
	{ value: "warn", label: "Warning" },
	{ value: "error", label: "Error" },
];

interface OptionSelectProps<Value extends string> {
	label: string;
	value: Value;
	options: { value: Value; label: string }[];
	onChange: (value: Value) => void;
}

function OptionSelect<Value extends string>({
	label,
	value,
	options,
	onChange,
}: OptionSelectProps<Value>) {
	return (
		<Select value={value} onValueChange={(next) => onChange(next as Value)}>
			<SelectTrigger aria-label={label} className="w-40 shrink-0">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ClearButton() {
	const empty = useConsoleStore((s) => s.rows.length === 0 && s.evictedCount === 0);
	const clear = useConsoleStore((s) => s.clear);
	return (
		<Button
			type="button"
			variant="outline"
			disabled={empty}
			className="shrink-0 gap-1.5"
			onClick={clear}
		>
			<Eraser className="size-icon" aria-hidden="true" />
			Clear
		</Button>
	);
}

interface ConsoleToolbarProps {
	filter: ConsoleFilter;
	onFilterChange: (change: Partial<ConsoleFilter>) => void;
}

export function ConsoleToolbar({ filter, onFilterChange }: ConsoleToolbarProps) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-1.5">
			<OptionSelect
				label="Type"
				value={filter.type}
				options={TYPE_OPTIONS}
				onChange={(type) => onFilterChange({ type })}
			/>
			<OptionSelect
				label="Level"
				value={filter.level}
				options={LEVEL_OPTIONS}
				onChange={(level) => onFilterChange({ level })}
			/>
			<div className="relative min-w-40 flex-1">
				<Search
					className="pointer-events-none absolute left-3 top-1/2 size-icon -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="text"
					value={filter.query}
					onChange={(event) => onFilterChange({ query: event.target.value })}
					aria-label="Search the console"
					placeholder="Method, URL, status or message"
					className="pl-10"
				/>
			</div>
			<ClearButton />
		</div>
	);
}
