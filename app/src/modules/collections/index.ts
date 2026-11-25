/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collections module's barrel: the drawer's collection tree (`CollectionTree`), its rows, their
 * contexts and the tree hooks.
 */

export { default as CollectionTree } from "./CollectionTree";
export { default as CollectionItem } from "./CollectionItem";
export type { CollectionItemProps } from "./CollectionItem";
export { default as RequestItem } from "./RequestItem";
export type { RequestItemProps } from "./RequestItem";
export {
	useCollectionTreeFolderDraft,
	useCollectionTreeHandlers,
	useCollectionTreeState,
} from "./context/CollectionTreeContext";
export { CollectionTreeProviders } from "./context/CollectionTreeProviders";
export type {
	CollectionTreeCrudHandlers,
	CollectionTreeCrudState,
	CollectionTreeDnd,
	CollectionTreeDragState,
	CollectionTreeDropTarget,
	CollectionTreeFolderDraft,
	CollectionTreeHandlers,
	CollectionTreeState,
} from "./context/CollectionTreeContext";
export { useRevealActiveSelection } from "./useRevealActiveSelection";
export { useTreeCrud } from "./useTreeCrud";
