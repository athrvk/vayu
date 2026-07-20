/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * CollectionPicker
 *
 * Shown only when a new request can't be placed unambiguously — no remembered
 * collection and more than one to choose from. After the first pick the choice
 * is remembered, so in practice this appears about once per workspace.
 */

import { Folder } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui";
import type { Collection } from "@/types";

interface CollectionPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	collections: Collection[];
	onSelect: (collectionId: string) => void;
}

export function CollectionPicker({
	open,
	onOpenChange,
	collections,
	onSelect,
}: CollectionPickerProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add request to</DialogTitle>
					<DialogDescription>Pick the collection for the new request.</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-72 flex-col gap-1 overflow-auto">
					{collections.map((collection) => (
						<button
							key={collection.id}
							type="button"
							onClick={() => onSelect(collection.id)}
							className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
							<span className="truncate">{collection.name}</span>
						</button>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
