/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

/**
 * @file httplib_client_url.hpp
 * @brief `<httplib.h>` for a translation unit that builds an `httplib::Client`
 *        from a URL.
 *
 * cpp-httplib 0.65.0's `Client (scheme_host_port, ...)` throws on an
 * unsupported scheme and then falls back to an invalid client, under
 * `#ifndef CPPHTTPLIB_NO_EXCEPTIONS` / `#endif` rather than `#else`. With
 * exceptions on, the fallback cannot be reached, and MSVC's `/Od` build (the
 * Windows ASan leg alone; `/O2` folds it away) reports it as C4702, which `/WX`
 * makes fatal. It is a code-generation warning, so `/external:W0` does not
 * cover it.
 *
 * MSVC attributes the warning to the line of the definition, so the
 * suppression has to cover the first parse of `<httplib.h>` in the translation
 * unit (the `ordered_json.cpp` shape). That is why a file that constructs a
 * client from a URL includes this header **first**, in an include block of its
 * own. Any later `#include <httplib.h>` is a no-op. This header goes when
 * cpp-httplib puts the fallback under `#else`.
 */
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4702)
#endif
#include <httplib.h>
#ifdef _MSC_VER
#pragma warning(pop)
#endif
