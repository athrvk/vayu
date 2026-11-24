/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request's own documentation, as the first request tab: free when unused, the whole pane for
 * the description when not, and first in reading order, which is what a description is for (as a
 * trailing tab it is a footnote you scroll past). Named "Info" like `CollectionDetail`'s first tab.
 * The name is edited here too: otherwise only the sidebar rename (F2 or the row menu) changed it,
 * and the surface calling itself the request's information said nothing about its name.
 */

import { Input, MarkdownEditor } from "@/components/ui";
import { reportBlankNameRefused } from "@/lib/blank-name";
import { useRequestBuilderContext } from "../../../context";
import { Eyebrow } from "@/components/ui/eyebrow";

export default function InfoPanel() {
	const { request, updateField, restoreStoredName, saveRequest, saveStatus } =
		useRequestBuilderContext();

	/*
	 * Trim, then commit, or refuse and restore the stored name. A request must keep a name and this
	 * is the builder's only field that can empty it, so a refusal is said and undone, not a dropped
	 * keystroke: the field shows the blank until you leave it, since a control that fights you
	 * mid-word is worse than one that corrects you at the end. A refused edit still sets
	 * `hasUnsavedChanges`, so the pending autosave fires with the restored (stored) name; hence no
	 * `saveRequest()` here.
	 */
	const commitName = () => {
		const trimmed = request.name.trim();
		if (!trimmed) {
			restoreStoredName();
			reportBlankNameRefused("request");
			return;
		}
		if (trimmed !== request.name) updateField("name", trimmed);
		void saveRequest();
	};

	return (
		<div className="flex flex-col gap-4 max-w-[76ch]">
			<div className="flex flex-col gap-2">
				<Eyebrow>Name</Eyebrow>
				<Input
					value={request.name}
					onChange={(e) => updateField("name", e.target.value)}
					onBlur={commitName}
					aria-label="Request name"
					placeholder="Get user by ID"
					className="text-sm font-medium"
				/>
			</div>

			<div className="flex flex-col gap-2">
				<Eyebrow>Description</Eyebrow>
				<MarkdownEditor
					value={request.description ?? ""}
					onChange={(v) => updateField("description", v)}
					onCommit={() => void saveRequest()}
					/*
					 * Blurring renders what is *stored*; after a failed save that is not what is on
					 * screen, so rendering would hide the edit still needing attention behind the
					 * old value.
					 */
					keepSourceOpen={saveStatus === "error"}
					aria-label="Request description"
					emptyHint="Add a description. Markdown renders when you click away."
				/>
			</div>
		</div>
	);
}
