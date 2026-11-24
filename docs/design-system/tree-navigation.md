---
description: >-
  The collection tree as a WAI-ARIA treeview with one tab stop: its roles, keys and the roving-tabindex protocol.
---

# Tree Navigation (roving tabindex)

The collection tree follows the WAI-ARIA treeview pattern: **the whole tree is one tab stop**.
Previously every row and every control in it was a stop - a workspace with 2 collections and 4 requests cost 17 presses to tab past.

- Container: `role="tree"`, holding every visible row as **one flat list** in the order `flattenVisibleRows` (`tree-rows.ts`) gives it (#2543): no row renders another, and there is no `role="group"`.
  Rows: `role="treeitem"`, `aria-expanded` on collections, `aria-selected` for the open entity.
  The new folder form and the "Empty collection" line are rows of the list too, but not treeitems.
- **The pitch is per row.**
  Every row is `h-8` and its wrapper carries the gap above it as top padding: `pt-0.5` between rows, `pt-1` above the first row inside an expanded folder (`rowSpacingAbove`) - the spacing the nested groups' `space-y-0.5` and `mt-1` drew, said from depth alone.
  The wrapper also states its height, the row's plus the gap (`h-8` / `h-8.5` / `h-9`, and `h-10` / `h-10.5` / `h-11` for the new-folder form; `rowHeightUnits`), so where every row sits is arithmetic over spacing units rather than a measurement.
  The gap is padding, not margin, so the wrapper can paint the indent guides across it (see "Tree indent guides").
- **Only the rows in view are in the DOM** (#2543).
  The drawer body mounts the rows it can show plus an overscan, and one `aria-hidden` spacer of the same units stands in for each run it skips, so the scrollbar is the whole list's.
  The treeitems in the DOM are therefore not the tree's rows: `aria-posinset`, `aria-setsize` and `aria-level` come from the full list and stay true of an unmounted neighbour.
  The rows that something holds stay mounted wherever the drawer is scrolled - the tab stop and the rows focus can be handed to from it, the new-folder form, the row being dragged.
  A list under 100 rows, or one in an environment with no layout, mounts everything.
- Rows render `tabIndex={-1}`; `useRovingTreeFocus` promotes exactly one to `0`.
- **The keys walk the rows, not the DOM.**
  `CollectionTree` hands the hook its visible rows as a `TreeRowModel`, so End, Home, the arrows, a typeahead and `*` reach rows that are scrolled away; moving focus scrolls the drawer to the row first, mounts it, and only then focuses it.
  The variables sidebar and the schema explorer pass no model and are walked through their mounted rows.
- Keys: Up/Down move, Home/End jump, Right expands then steps in, Left collapses then moves to the parent, Enter/Space opens, **F2** renames, **Delete / Backspace** deletes, **Shift+F10 / Menu / Shift+Enter** opens row actions, **typeahead** jumps to the next row whose name starts with what you type, **`*`** expands every folder at the focused row's level.
- **Right-click is the pointer equivalent of Shift+F10 / Menu / Shift+Enter** (issue #1360):
  it opens the same row-actions list - through the tree's one `CollectionTreeContextMenu` in the collection tree, `RowContextMenu` on the variables sidebar's rows - and focuses the row on the way past, so Escape returns focus there rather than dropping it to `<body>` - the tree still has to hold its one tab stop after the menu closes, whichever way it opened.
  An action that opens a field (Add collection, Rename) is the exception to that hand-back; see `opensField` below.
- **The second binding on those two is what a Mac keyboard can reach.**
  The key labelled "delete" on a Mac reports `"Backspace"` (`"Delete"` is forward-delete, Fn+Delete), and Mac keyboards have no Menu key and default F10 to a media key - so the `Delete`-only and `Shift+F10`-only versions were dead on macOS while passing every test, since jsdom reports one platform.
  Both bindings are live on every platform rather than behind an `isMac` fork; the tests fire both keys and assert neither the host nor a stubbed platform.
- **Alt+Arrow moves the row itself**, the keyboard half of drag-and-reorder: Up/Down among its siblings, Right into the folder rendered above it, Left out to after its parent.
  Alt because the tree owns the bare arrows and the app owns Ctrl/Cmd; every move is announced in the live region below.
  The tab strip answers the same chord on a focused tab (Alt+Arrow one place, Alt+Home/End to an end), and like the tree stops the event so it never reaches the window's Go back.
- **The row menu carries the same moves with no chord at all**: **Move up**, **Move down** and **"Move to…"** (issue #1690).
  A chord has to be known before it can be used, so until these existed a keyboard user who had not read the shortcut list could not reorder the tree - while the element list had carried Move up / Move down in its own menu all along, which made one action two actions depending on the list.
  They call the same `moveByKeyboard` the chords do (one move, one function) and are off at the ends carrying "Already first" / "Already last" as a `disabledReason`, gated off the same block the announcement is computed from.
  They sit above the row's destructive tail, since the separator there belongs to Delete.
- Every control inside a row is `tabIndex={-1}`, so those keys are the *only* keyboard path to row actions - do not remove one without providing another.
  Both row types must render every hidden control: a folder row without `data-tree-delete` swallowed Delete silently for months, because the hook `preventDefault`s the key whether or not it finds something to click.

**Those keys reach a control by clicking it, so the control has to answer a click.**
The hook calls `.click()` on the row's `[data-tree-menu]`, and Radix's dropdown trigger opens on `pointerdown` and on its own `keydown` - neither of which a programmatic click dispatches.
Every menu-only action (Duplicate, Move to, Run, Add, Export) was therefore mouse-only, on a path the tree advertised (#1212).
`RowActionsMenu` now holds its own open state and opens on a click reporting `detail === 0`, which is what a click with no pointer behind it reports - the mouse path stays Radix's, since its own `pointerdown` has already opened the menu by the time a real click arrives.
The hidden `<button>` controls answer a click by being plain buttons; anything richer added to a row has to declare how it answers one.

**`RowActionsMenu` takes its `tabIndex` from the row.**
It is `0` by default - outside a tree the `⋯` menu is an ordinary tab stop - and these rows pass `-1`, because the tree is one tab stop and the keys above are the way in.
Closing the menu hands focus back to the *row*, not to the trigger Radix would return it to: a `tabIndex={-1}` control holding the tree's focus is a stop the user cannot Tab back to.

**An action that opens a field runs after its menu has closed** (`opensField` on the `RowAction`, #3443; Add collection and the Rename of the tree and the variables sidebar).
The menu's focus scope is still trapping when `onSelect` runs, so a field mounted from there claims focus and is yanked back into the menu, and the close then hands focus to the row: the field shows but the row holds the keys, so typing drives the typeahead, Backspace deletes the row, and a rename's blur commits the name unchanged.
The menu instead records the action and runs it from `onCloseAutoFocus` - Radix's signal that its cleanup is done - skipping the hand-back to the row, so the field mounts into a page nothing else is holding focus on.
Both menus do this through `useAfterMenuClose`, because the `⋯` dropdown and right-click are different Radix families with the same trap.
An action that opens no field stays on `onSelect`.

Rows declare behaviour through data attributes rather than props (`data-tree-activate`, `data-tree-toggle`, `data-tree-menu`, `data-tree-rename`, `data-tree-delete`, `data-tree-move-up` / `-down` / `-in` / `-out`, `data-tree-label`), so the hook needs nothing threaded through `CollectionItem`'s prop list.
`data-tree-label` is the row's name for typeahead and is not optional decoration: a request row's `textContent` starts with its method badge and a folder's ends with its child count, so matching the text would search a string the user never sees.

**Focus is not selection.**
Arrows move focus without opening anything; Enter opens.
Keep roving focus, `aria-selected`, and the open tab in tabs-store distinct - conflating them is the classic treeview bug.

**The whole row is the drag handle, and that is only safe because the discriminator is movement.**
There is no grip icon: the row already fought dead zones to become clickable everywhere (see the hit-area rule above), and a grip would hand most of that area back.
A press becomes a drag at ~4px and not before, so every click affordance survives - and the completed drag swallows the one click the browser fires after it, or the row it was just dropped on would open.
Never a timer: `RequestItem.test.tsx` pins that opening is synchronous.

**The drag's pointer handlers must ignore what a row's menu sends them.**
They sit on the `role="tree"` element, one set for every row (#2543), and a press resolves its row from the rows model.
The ⋯ menu is a React child of the row and a *portal* in the DOM, and React bubbles synthetic events through the component tree - so a press on "Delete" arrives at the tree's `onPointerDown`.
Taking it would capture the pointer, the capture retargets the `pointerup` the menu item was waiting for, and every action in every row menu stops working while looking perfectly normal.
`closest("[data-tree-menu]")` does not catch it (portalled content is not inside its trigger); a DOM containment check - `currentTarget.contains(target)` - does, and is the guard on every one of those handlers.

**The capture is the tree's, and it is taken when the press becomes a drag.**
On the tree rather than the row, so a source row the drawer has scrolled out of the window cannot take the gesture with it; at the threshold rather than the press, because a captured press clicks the capturing element and a click on a row has to land on the row's own controls.
A press carried out of the tree before it is a drag is dropped, since its release would land where the tree never hears it.

**Drop indicators are classes on rows that already exist.**
A line between two rows is a 2px `bg-primary` span positioned inside a row and indented to the depth of the row the drop lands beside - the depth is the only thing separating "after this collapsed folder", "into it" and "after its parent".
A drop after an *open* folder lands after everything in it, so its line is drawn under the last visible row of the folder's subtree (a request, a sub-folder's last row, the "Empty collection" line or the new-folder form), still at the folder's indent: the folder row's own bottom edge is the seam above its first child, a different drop (#3447).
Dropping *into* a folder reuses the selected-row ring.
While the drawer auto-scrolls under a held pointer, every scroll frame hit-tests again, so the line and the drop follow the row the scroll brings under the pointer.
Nothing new gets `role="treeitem"`: an indicator node between rows would join the tree's rows and change its shape mid-drag - a row with no level, sitting between a folder and its children.
The row being dragged stays mounted however far the drawer auto-scrolls from it, so the source keeps its place and its dimmed state for the whole gesture.
A row that cannot take the drop is dimmed and carries `data-drop-blocked` - the dragged row itself and a dragged folder's own subtree.
A folder's sub-folders and requests are one list (#2535), so a row of the other kind is a legal neighbour, not a blocked one.

**The tab strip joins the tree** (#2039), with the same rules in one dimension.
The whole tab is the handle and a press becomes a drag at the same ~4px (the shared `lib/drag/drag-gesture`), so a click that wobbles still activates the tab and a completed drag swallows its one trailing click.
The source dims with the same `opacity-50`.
The slot is the same 2px `--primary` line (`DropIndicator`), drawn `vertical` on the edge of the tab beside the gap: before the first tab, between two, or after the last one rendered.
Nothing is drawn where a drop would leave the tab in place, and a release above or below the strip, or Escape, cancels.
There is **no indicator node in the tablist**: a `role="tab"` sibling would change the tab set the way a `treeitem` would change the tree, so the line is a child of an existing tab.
Two things the tree has and the strip does not: no edge auto-scroll (the strip is `overflow-hidden` and the "+N" menu holds what does not fit, whose entries are not draggable) and no slide animation - the moved tab is re-keyed and the strip reflows, so the only motion is the opacity transition a tab already carries, which the reduced-motion rules collapse.

**A rename must hand focus back.**
The rename field replaces the row's label and then unmounts, so closing it from the keyboard (Enter or Escape) with nothing to catch focus drops the user to `<body>` and the next Tab restarts from the top of the document.
Both row types refocus their own row.
A *blur* deliberately does not - focus has already gone where the user sent it.

**A delete must hand focus on, because the row it came from is gone.**
The confirm dialog is rendered controlled with no trigger, and a trigger is what Radix aims its close-focus at - so both outcomes dropped the user to `<body>` (#1218).
Cancel returns focus to the row, which is still there.
A delete that actually removes the row moves focus to the **next row in the deleted row's own set**, or to the **parent** when that row was the last in it: chosen while the row is still on screen, since afterwards the DOM cannot say what followed it.
Focus moves through `focusTreeRow`, so the tree's one tab stop travels with it.
In the windowed collection tree the successor, the parent and the row before are kept mounted beside the row holding the tab stop, and for a commit after it leaves, so the answer read from the mounted rows is the one the whole list gives (`rowsAroundFocus`).

**A request row's `⋯` menu stays mounted while its delete runs** (#3443).
The menu is what hands focus back to the row the delete was invoked from, and `useDeleteRefocus` then moves on from that row once it leaves; a menu unmounted at the start of the delete took the hand-back with it and left the removed row's focus on `<body>`.
Only a rename removes it, as on a folder row.

**A dialog opened from a row's menu hands focus back to that row.**
Move to, Run collection and both exports are controlled dialogs with no trigger, and the menu item that opened them closes with its menu, so Radix's restore has nowhere to land - `<body>`, again.
`CollectionTree` passes each an `onCloseAutoFocus` that focuses the row through the window (`revealRow` + `focusTreeRow`), so the row is mounted even if the dialog's own scrolling moved it away, and the tab stop travels with it.

**A folder just created is revealed** (#3443).
It lands where the sort puts it - the end of the root list, or the top of its parent - which in a long tree is off screen, so the create calls `revealEntity` (`useRevealActiveSelection`, the same reveal a move uses): ancestors expanded, the row mounted and scrolled to through the window, focus and the tab stop on it.
The new-folder field that held focus unmounts with the create, so without this focus fell to `<body>`.

**A tree that runs out of rows still has to name somewhere.**
The rules above answer for every row but one: a root falls back to the root before it, so it takes the *whole tree emptying* - the deleted row was the only one there was - for the honest answer to "which row now" to be *none*, which is `<body>` again unless the caller says otherwise.
So the last resort is the caller's to name, and it is a control rather than a row: the collection tree hands focus to **Add collection**, the one thing left to do on an emptied tree, and the Trash view - flat, with no create control of its own - to its **list container**, which stays mounted holding the empty state.
The variables sidebar names none, and needs none: every environment row is a level-2 child of the Environments header, so the parent rule above always answers.
A last resort is not a row, so it does not travel through `focusTreeRow` - moving the roving tab stop onto it would take that stop off the tree altogether.

**Which of the two it is, is read from the outcome and never from the confirm click.**
The dialog closes on a failure as much as on a success, and nothing at close time can say which happened - `confirmDelete` returns `void`, and an awaited answer arrives after Radix has already moved focus.
Read as intent, a *failed* delete landed the user beside a row that was still sitting there (#1234).
So the decision waits instead: focus goes back to the row at close, and moves to the successor only once that row actually leaves the DOM - which for a successful delete is normally a later render, when the refetch lands.
A user who has moved focus on in the meantime keeps it; the move only happens out of `<body>`, where the removal itself left it.
The waiting is `useRemovalRefocus` (`app/src/hooks/`), shared with the Trash view's permanent delete - a flat list, so its rule is the next row, or the previous one when the purged row was last.
Both trees that can delete a row - the collection tree and the variables sidebar, which grew its Delete key in #1217, after the rule was written - reach it through the one `useDeleteRefocus`, which each tells only which attribute identifies its rows and where its last resort is (#1279).

**Order comes from the rows; hierarchy comes from `aria-level`.**
In the variables sidebar and the schema explorer the DOM states order plainly - `[role="treeitem"]` in document order is exactly the rows a user can see, since collapsed subtrees are not rendered.
The collection tree mounts only a window of its rows, so its order comes from the list `flattenVisibleRows` builds, handed to the hook as a `TreeRowModel`, and its levels with it.
Parentage the DOM does not state in any of them: a row's children are rendered **beside** it, never nested within it - in the collection tree every row is a sibling in one flat list - so `closest()` finds nothing.
When the children sat in a shared wrapper, a walk up the ancestors took whichever treeitem an ancestor held first - a group's own first row, which is a preceding *sibling* of every row after it.
Under that walk Left moved to the top of a list instead of out of it, and self-corrected on the next press, so it read as hesitation rather than as breakage (#1237).
One function answers the question now - `parentIndex` in `tree-focus.ts`, the nearest row above with a smaller level, which `parentRow` applies to a list of mounted rows - and both the Left key and the delete refocus read it, so there is one description of this tree's shape rather than two that can drift.

**A consumer of the hook therefore has to announce `aria-level` on every row**, and all three do.
It is not only for assistive tech: a tree that omits it is a tree of roots, where Left moves nowhere and `*` calls every row a sibling.
The schema explorer is why the level and not the shape is the source - it renders every row, at every depth, as a direct child of the tree, so no DOM rule can answer for it at all.

**That same shape is why the hierarchy has to be stated, not inferred.**
Rows that are siblings in the DOM read as a flat list of rows.
Every row carries `aria-level` (1-based), `aria-posinset` and `aria-setsize`, and in the collection tree those three are the whole of the hierarchy: a flat list holds no `role="group"` to own a folder's children, so there is none, and no `aria-owns` tying one to its folder (both went with the nesting, #2543).
Folders and requests under one parent are **one** set - the requests continue the folders' numbering, or two adjacent rows both announce "1 of 1".

`CollectionTree` also renders one polite live region (`data-tree-live`).
It shipped empty, ahead of anything that wrote to it, on purpose: a live region added at the same moment as its first message is not reliably announced (the same constraint `ResponseAnnouncer` carries).
What writes to it now is a move - "Moved Get Users to position 2 of 5 in Billing", or the reason a move did not happen ("Get Users is already first in Billing"), which is the only feedback a keyboard user gets for a row that visibly went nowhere.

Currently on `CollectionItem` and `RequestItem` rows and on every row of the variables sidebar (`VariablesCategoryTree`, #1217), which is a roving-tabindex tree for the same reason: its Rename and Duplicate live only in the row's ⋯ menu, so a row that was not a `treeitem` left both unreachable without a mouse.
**Otherwise only needed where the control and the row genuinely differ** - the history and settings trees use full-width buttons that are their own target, so they use the baseline.
Before adding it, check whether the focusable element already spans the row.

**The variables sidebar shows what a second consumer costs.**
Two things there are not the collection tree's, and both are decisions rather than omissions:

- **Its section headers are rows.**
  Globals, Environments and Collections are the three level-1 treeitems and the two lists are their children, so one arrow key walks the whole sidebar and the headers get expand/collapse from Right/Left.
  The header's one button is both `data-tree-toggle` and `data-tree-activate`, because for a header those two verbs are the same one.
- **"Add environment" is still a tab stop**, and sits outside the header row's treeitem.
  The tree owns no "create" key, so a `tabIndex={-1}` there would make creating an environment mouse-only - the defect the tree was adopted to fix, pointing the other way.
  The tree is one stop; that button is the second.

A row that does not carry a control still has to declare it: an environment row renders the hidden `data-tree-rename` and `data-tree-delete` buttons, because the hook `preventDefault`s F2 and Delete whether or not it finds something to click.

**The other roving strip is not a tree, and does not use the hook.**
The `{{variable}}` tokens `VariableInput` paints over a field share one Tab stop the same way - one token at `tabIndex={0}`, the rest at `-1`, Left/Right between them and Home/End to the ends - because a URL with five variables otherwise put five stops between the URL and Send (issue #1215).
It is wired in the component rather than taken from either half of the tree's machinery, for two different reasons.
`useRovingTreeFocus` navigates `[role="treeitem"]` and acts by dispatching at the tree's own `data-tree-*` attributes, so pointed at tokens it would find nothing and silently do nothing.
`focusTreeRow` (`tree-focus.ts`) is closer - it is exactly "move the stop and focus the row" - but it moves the stop by writing `tabIndex` onto DOM nodes, which is right for the tree, whose rows render `tabIndex={-1}` and do not re-render for it, and wrong here:
the token strip's stop *is* a React prop, so the same write would sit on top of a vdom value React still believes and be undone by the next render.
Arrowing does not wrap there - falling off the end leaves Tab as the way out, per **Focus must be able to leave** above.
