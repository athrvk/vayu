/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/*
 * The provider alone. `CodeEditor` imports the hook from its own module and the
 * tests import the context from theirs, deliberately: a `components/ui`
 * primitive reaching this barrel would drag the provider - and the request
 * builder behind it - in with the hook.
 */
export { EditorVariableTokensProvider } from "./EditorVariableTokensProvider";
