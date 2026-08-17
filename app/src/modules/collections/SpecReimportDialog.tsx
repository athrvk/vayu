/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The fork an import takes when the document is one a collection already binds
 * (issue #680).
 *
 * **A fork, never a block.** Wanting a second copy of a spec is a real thing to
 * want - a scratch collection, a before-and-after - so Import anyway does
 * exactly what pressing Import did before this dialog existed. What was missing
 * was the other road: Sync, which is the documented path for a document that
 * moved, and which a re-import silently walked past.
 *
 * The Sync action is per row rather than in the footer because a batch can carry
 * more than one bound document, and one Sync button would have to guess which
 * collection it meant. One row, one collection, no rule to remember.
 */

import { useRef } from "react";
import { FileJson, RefreshCw } from "lucide-react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui";
import type { SpecReimportMatch } from "@/services/openapi/bound-spec-match";

interface SpecReimportDialogProps {
	/** Every document in this import that a collection already binds. */
	matches: readonly SpecReimportMatch[];
	/** Show that collection's Spec tab, where Sync lives. */
	onSync: (collectionId: string) => void;
	/** Import all of it anyway, second collection and all. */
	onImportAnyway: () => void;
	/** Back to the preview, having written nothing. */
	onCancel: () => void;
}

export default function SpecReimportDialog({
	matches,
	onSync,
	onImportAnyway,
	onCancel,
}: SpecReimportDialogProps) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const several = matches.length > 1;

	return (
		<Dialog open onOpenChange={(next) => !next && onCancel()}>
			<DialogContent
				className="sm:max-w-lg"
				// Radix would land focus on the corner close button, which reads as
				// nothing being focused. Cancel is the action that writes nothing,
				// so a reflexive Enter goes back to the preview - the same rule
				// DeleteConfirmDialog follows.
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{several
							? "These specs are already bound to collections"
							: "This spec is already bound to a collection"}
					</DialogTitle>
					<DialogDescription>
						Importing again makes a second collection from scratch - without the
						operation identities, saved examples or coverage history the bound one has.
						Syncing updates the collection you already have.
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					<ul className="space-y-2">
						{matches.map((match) => (
							<li
								key={match.entryId}
								className="flex items-center gap-3 rounded-md border border-rule surface-sunken p-2"
							>
								<span className="min-w-0 flex-1">
									<span className="flex items-baseline gap-1.5">
										<FileJson className="h-3.5 w-3.5 shrink-0 text-primary" />
										<span className="truncate text-xs font-medium">
											{match.label}
										</span>
									</span>
									<span className="block text-[11px] text-muted-foreground">
										Bound to{" "}
										<span className="font-medium text-foreground">
											{match.collectionName}
										</span>{" "}
										-{" "}
										{match.matchedBy === "sourceUrl"
											? "the same URL that collection was bound from, so this may be a newer version of it"
											: "byte for byte the document that collection is bound to"}
									</span>
								</span>
								<Button
									variant="outline"
									onClick={() => onSync(match.collectionId)}
								>
									<RefreshCw className="mr-2 h-4 w-4" />
									Sync instead
								</Button>
							</li>
						))}
					</ul>
				</DialogBody>

				<DialogFooter className="gap-2 sm:gap-0">
					<Button ref={cancelRef} variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
					<Button onClick={onImportAnyway}>Import anyway</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
