/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a surface says when it asked Vayu's engine for something and got no
 * sentence back: not running, dropped the connection, or sent an empty error.
 * It names the engine as Vayu's own and gives the one step a user can take, so
 * a caller shows it as-is (or after a lead-in of its own) rather than writing a
 * bare "the engine did not answer" of its own.
 */
export const ENGINE_NO_ANSWER = "Vayu's engine isn't running or didn't answer. Restart Vayu.";
