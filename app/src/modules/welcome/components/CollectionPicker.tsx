/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * CollectionPicker
 *
 * Shown only when a new request can't be placed unambiguously - no remembered
 * collection and more than one to choose from. After the first pick the choice
 * is remembered, so in practice this appears about once per workspace.
 *
 * A nested collection carries its parent path under the name: two "Users"
 * folders under different parents are otherwise the same row twice (#1881).
 */

import { useMemo } from "react";
import { Folder } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui";
import { collectionPath } from "@/modules/collections/tree-utils";
import type { Collection } from "@/types";
import { TruncatedText } from "@/components/shared";

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
	const byId = useMemo(() => new Map(collections.map((c) => [c.id, c])), [collections]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add request to</DialogTitle>
					<DialogDescription>Pick the collection for the new request.</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex max-h-72 flex-col gap-1">
					{collections.map((collection) => {
						const parentPath = collection.parentId
							? collectionPath(collection.parentId, byId)
							: "";
						return (
							<button
								key={collection.id}
								type="button"
								onClick={() => onSelect(collection.id)}
								className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Folder className="size-icon shrink-0 text-muted-foreground" />
								<span className="flex min-w-0 flex-col">
									<TruncatedText>{collection.name}</TruncatedText>
									{parentPath && (
										<TruncatedText className="text-xs text-muted-foreground">
											{parentPath}
										</TruncatedText>
									)}
								</span>
							</button>
						);
					})}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
