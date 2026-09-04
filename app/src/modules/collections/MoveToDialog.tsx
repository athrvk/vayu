/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Move to...": the row menu's answer to a drag, for anyone not making one.
 *
 * Alt+Arrow already gives the keyboard full parity with the pointer, but it is
 * a chord and it moves one step at a time. This is the discoverable version -
 * pick a destination, the row lands at the end of that folder's matching block
 * - and it is the only path that does not require knowing the feature exists.
 *
 * The candidate list is the same refusal set the drag enforces, computed from
 * the same `isDescendant`: a folder cannot move into itself or its own subtree,
 * and neither kind of row is offered the parent it is already in.
 */

import { Folder, FolderTree } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	Button,
} from "@/components/ui";
import { isDescendant } from "./tree-utils";
import type { TreeEntity } from "./drop-position";
import type { Collection } from "@/types";
import { compareTreeOrder } from "@/types";
import { rowInsetPx } from "@/constants/layout";

export interface MoveToDialogProps {
	/** The row being moved; `null` closes the dialog. */
	entity: TreeEntity | null;
	collections: Collection[];
	onClose: () => void;
	/** `null` is the top level, which only a collection can be moved to. */
	onMove: (entity: TreeEntity, ownerId: string | null) => void;
}

/** A candidate destination, with the depth its label is indented by. */
interface Candidate {
	collection: Collection;
	depth: number;
}

/**
 * Every collection a row may move into, in tree order, with the ones it may not
 * removed rather than shown disabled - a list of refusals is not a chooser.
 */
function moveCandidates(entity: TreeEntity, collections: Collection[]): Candidate[] {
	const currentOwner = entity.kind === "collection" ? entity.parentId : entity.collectionId;
	const walk = (parentId: string | null, depth: number): Candidate[] =>
		collections
			.filter((c) => (c.parentId ?? null) === parentId)
			.sort(compareTreeOrder)
			.flatMap((collection) => {
				const self = entity.kind === "collection" && collection.id === entity.id;
				const inSubtree =
					entity.kind === "collection" &&
					isDescendant(collection.id, entity.id, collections);
				const children = self ? [] : walk(collection.id, depth + 1);
				if (self || inSubtree || collection.id === currentOwner) return children;
				return [{ collection, depth }, ...children];
			});
	return walk(null, 0);
}

export function MoveToDialog({ entity, collections, onClose, onMove }: MoveToDialogProps) {
	if (!entity) return null;

	const candidates = moveCandidates(entity, collections);
	// Only a collection can sit at the top level; a request always belongs to
	// one, which is why the reorder batch has no root requests scope.
	const offersTopLevel = entity.kind === "collection" && entity.parentId !== null;
	// Named so the description says where the row is now, which is the thing a
	// list of destinations cannot show.
	const owner = entity.kind === "collection" ? entity.parentId : entity.collectionId;
	const ownerName = owner
		? (collections.find((c) => c.id === owner)?.name ?? "a collection")
		: "the top level";

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Move &ldquo;{entity.name}&rdquo;</DialogTitle>
					<DialogDescription>
						Currently in {ownerName}. Choose where it should go - it lands at the end.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="max-h-72 -mx-1 px-1">
					{offersTopLevel && (
						<Button
							variant="ghost"
							className="w-full justify-start gap-2 h-8"
							onClick={() => onMove(entity, null)}
						>
							<FolderTree className="w-4 h-4 shrink-0 text-primary" />
							<span className="truncate text-sm">Top level</span>
						</Button>
					)}
					{candidates.map(({ collection, depth }) => (
						<Button
							key={collection.id}
							variant="ghost"
							className="w-full justify-start gap-2 h-8"
							style={{ paddingLeft: rowInsetPx(depth) }}
							onClick={() => onMove(entity, collection.id)}
						>
							<Folder className="w-4 h-4 shrink-0 text-primary/70" />
							<span className="truncate text-sm">{collection.name}</span>
						</Button>
					))}
					{candidates.length === 0 && !offersTopLevel && (
						<p className="px-2 py-6 text-center text-sm text-muted-foreground">
							There is nowhere else to move this.
						</p>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
