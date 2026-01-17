
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collections Module
 *
 * Components for managing collections and requests.
 *
 * Location: Sidebar only
 * - All components in this module are displayed in the sidebar
 * - CollectionTree is the main component shown in the Collections tab
 */

export { default as CollectionTree } from "./CollectionTree";
export { default as CollectionItem } from "./CollectionItem";
export type { CollectionItemProps } from "./CollectionItem";
export { default as RequestItem } from "./RequestItem";
export type { RequestItemProps } from "./RequestItem";
