/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The variables module: globals, collection-scoped and environment variables. `sidebar/` holds the
 * category tree (`VariablesCategoryTree`), `main/` the editor; import from either directly, or from
 * here through the `sidebar` / `main` namespaces.
 */

export * as sidebar from "./sidebar";

export * as main from "./main";

export { default as VariablesCategoryTree } from "./sidebar/VariablesCategoryTree";
export { default as VariablesEditor } from "./main/VariablesMain";
export { default as VariableTableEditor } from "./main/VariableTableEditor";
