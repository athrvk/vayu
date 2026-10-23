/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Loader2 } from "lucide-react";
import {
	useCollectionTreeFolderDraft,
	useCollectionTreeHandlers,
	useCollectionTreeState,
} from "./context/CollectionTreeContext";
import { Button, DialogCancelButton, Input } from "@/components/ui";
import { treeGuideStyle } from "./tree-guide-style";
import { isCommitEnter } from "@/lib/keyboard";
import { rowInsetPx } from "@/constants/layout";

/**
 * The inline "new collection" form a folder row opens, as the first row under it.
 *
 * A component of its own, not markup in `CollectionItem`, because it is the one
 * reader of the draft name: that string changes on every keystroke, and a folder
 * row that read it would re-render with each one. Here the keystroke renders
 * this form and nothing else (#2543).
 */
export default function NewFolderForm({
	parentId,
	depth,
	activeGuideLevel,
}: {
	parentId: string;
	depth: number;
	activeGuideLevel: number | null;
}) {
	const { newFolderName } = useCollectionTreeFolderDraft();
	const { isCreatingSubfolder } = useCollectionTreeState();
	const { onFolderNameChange, onCreateSubfolder, onCancelSubfolder } =
		useCollectionTreeHandlers();

	return (
		<div
			className="flex gap-2 py-1 pr-2"
			style={{ paddingLeft: rowInsetPx(depth), ...treeGuideStyle(depth, activeGuideLevel) }}
		>
			<Input
				size="sm"
				type="text"
				value={newFolderName}
				onChange={(e) => onFolderNameChange(e.target.value)}
				onKeyDown={(e) => {
					// `isCommitEnter`, not a bare Enter (#939, #935): an IME commits its
					// composition buffer with an ordinary Enter keydown, and mod+Enter is
					// the Send chord, not this field's create.
					if (isCommitEnter(e)) onCreateSubfolder(parentId);
					if (e.key === "Escape") onCancelSubfolder();
				}}
				placeholder="Collection name"
				className="flex-1 text-sm"
				disabled={isCreatingSubfolder}
				autoFocus
			/>
			<Button
				size="sm"
				onClick={() => onCreateSubfolder(parentId)}
				disabled={isCreatingSubfolder}
			>
				{isCreatingSubfolder && <Loader2 className="size-icon-sm animate-spin" />}
				Add
			</Button>
			<DialogCancelButton
				size="sm"
				onClick={onCancelSubfolder}
				disabled={isCreatingSubfolder}
			/>
		</div>
	);
}
