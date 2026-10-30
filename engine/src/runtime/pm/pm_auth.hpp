#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_auth.hpp
 * @brief Postman's `{ type, <type>: params }` auth block, read for both
 *        surfaces that take one: `pm.sendRequest`'s `options.auth` and
 *        `pm.request.auth` (#3131).
 *
 * Its own header rather than part of `pm_internal.hpp`: `vayu::http::Auth`
 * lives beside the OAuth 2.0 token cache, whose sqlite_orm include every other
 * `pm/` file would otherwise compile.
 */

#ifdef VAYU_HAS_QUICKJS

#include "pm_internal.hpp"

#include <optional>
#include <string>
#include <string_view>

#include "vayu/http/auth_resolver.hpp"

namespace vayu::runtime::pm_detail {

/// Where a script handed over an auth block, as the refusals name it.
struct ScriptAuthSlot {
    /// The slot a refusal opens with: `pm.sendRequest options.auth`.
    std::string_view label;
    /// The slot as the script spells a member of it: `options.auth`, so a
    /// missing block is named `options.auth.basic`.
    std::string_view path;
};

/**
 * Read @p value as Postman's auth block into the engine's typed `Auth`.
 *
 * `basic`, `bearer`, `apikey` and `noauth` (or `none`) become the variants
 * `vayu::http::apply_auth` composes; every other type, `oauth2` included, is
 * refused naming it, because acquiring a token needs the database the sandbox
 * does not hold. A parameter block may be `[{ key, value }]`, as an exported
 * collection carries it, or `{ name: value }`, as a script hand-writes it.
 * Undefined or null leaves @p out as it was.
 *
 * @return why the block was refused, or nullopt when @p out is filled.
 */
std::optional<std::string> read_script_auth (JSContext* ctx,
JSValueConst value,
const ScriptAuthSlot& slot,
vayu::http::Auth& out);

/**
 * Every credential of @p auth resolved against the scopes the script can see,
 * through the walk `apply_auth` shares, so a credential cannot be resolved in
 * one place and applied from another. @p label names the slot in the refusal
 * for a data column the bound row does not carry.
 */
std::optional<std::string>
resolve_script_auth (JSContext* ctx, vayu::http::Auth& auth, std::string_view label);

} // namespace vayu::runtime::pm_detail

#endif // VAYU_HAS_QUICKJS
