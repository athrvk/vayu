/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * InfoPanel - the request's own documentation.
 *
 * **This used to be a band above the tabs.** `RequestDescription` drew a
 * full-width row between the URL bar and the tab strip, with its own background
 * and its own rule, and it drew it whether or not a description existed - so
 * every request in the app paid ~30px permanently for a button reading "Add
 * description…". Together with the URL bar that was 80px of chrome for one
 * logical header.
 *
 * It is now the first request tab, which costs nothing when unused and gives
 * the description the whole pane when it is. First position rather than last is
 * the part that makes it work: as a trailing tab it is a footnote you scroll
 * past, and at the head of the row it is first in reading order - which is what
 * a description is for.
 *
 * Named "Info" to match `CollectionDetail`'s first tab, and because the panel
 * is the natural home for more than the description later. The name is the
 * first tenant that arrived: it was editable only from the sidebar row's rename
 * (F2 or the row menu) and shown only in the tab strip, so the one surface
 * calling itself the request's information had nothing to say about what the
 * request was called.
 *
 * The old component also carried a `open` flag, an auto-open-on-content effect
 * and a close-on-blur-when-empty rule, none of which has anywhere to live now.
 * They are deleted rather than ported.
 */

import { Input, MarkdownEditor } from "@/components/ui";
import { reportBlankNameRefused } from "@/lib/blank-name";
import { useRequestBuilderContext } from "../../../context";

export default function InfoPanel() {
	const { request, updateField, restoreStoredName, saveRequest, saveStatus } =
		useRequestBuilderContext();

	/*
	 * Trim, then commit - or refuse and put the stored name back.
	 *
	 * A request must keep a name, and this field is the only place in the
	 * builder that can empty it. Refusing means saying so and undoing it, not
	 * quietly dropping the keystroke: the field goes on showing the blank until
	 * you leave it, because a control that fights you mid-word is worse than one
	 * that corrects you at the end.
	 *
	 * The refused edit still leaves `hasUnsavedChanges` set, so the pending
	 * auto-save fires - carrying the restored name, which is what is stored
	 * anyway. That is why there is no `saveRequest()` on this path.
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
				<div className="text-[11px] uppercase tracking-wide text-subtle-foreground">
					Name
				</div>
				<Input
					value={request.name}
					onChange={(e) => updateField("name", e.target.value)}
					onBlur={commitName}
					aria-label="Request name"
					placeholder="Name this request…"
					className="text-sm font-medium"
				/>
			</div>

			<div className="flex flex-col gap-2">
				<div className="text-[11px] uppercase tracking-wide text-subtle-foreground">
					Description
				</div>
				<MarkdownEditor
					value={request.description ?? ""}
					onChange={(v) => updateField("description", v)}
					onCommit={() => void saveRequest()}
					/*
					 * Blurring renders what is *stored*. If the save that blur fired
					 * failed, the stored text is not what is on screen, so rendering
					 * would hide the edit that still needs attention behind a tidy
					 * view of the old value.
					 */
					keepSourceOpen={saveStatus === "error"}
					aria-label="Request description"
					emptyHint="Add a description… Markdown is rendered when you click away."
				/>
			</div>
		</div>
	);
}
