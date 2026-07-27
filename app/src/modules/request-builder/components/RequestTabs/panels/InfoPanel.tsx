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
 * is the natural home for more than the description later.
 *
 * The old component also carried a `open` flag, an auto-open-on-content effect
 * and a close-on-blur-when-empty rule, none of which has anywhere to live now.
 * They are deleted rather than ported.
 */

import { MarkdownEditor } from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";

export default function InfoPanel() {
	const { request, updateField, saveRequest } = useRequestBuilderContext();

	return (
		<div className="flex flex-col gap-2 max-w-[76ch]">
			<div className="text-[11px] uppercase tracking-wide text-subtle-foreground">
				Description
			</div>
			<MarkdownEditor
				value={request.description ?? ""}
				onChange={(v) => updateField("description", v)}
				onCommit={() => void saveRequest()}
				aria-label="Request description"
				emptyHint="Add a description… Markdown is rendered when you click away."
			/>
		</div>
	);
}
