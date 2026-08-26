#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/curl_options.hpp
 * @brief The typed seam over libcurl's three variadic entry points - issue
 *        #1023's answer to `cppcoreguidelines-pro-type-vararg`.
 *
 * `curl_easy_setopt`, `curl_multi_setopt` and `curl_easy_getinfo` are
 * `(handle, constant, ...)`. The variadic argument is read back as whatever
 * the constant says it should be, and nothing checks that the caller passed
 * that: `curl_easy_setopt (curl, CURLOPT_TIMEOUT_MS, 30000)` compiles, and
 * libcurl then reads a `long` out of an `int`'s promotion slot. Passing an
 * `int*` where `CURLINFO_RESPONSE_CODE` writes a `long` is the same defect
 * pointing the other way, and that one corrupts the stack.
 *
 * Every option and info constant carries its own argument type. An option is
 * `CURLOPTTYPE_<category> + index`, the categories a decade apart
 * (`LONG` 0, `OBJECTPOINT` 10000, `FUNCTIONPOINT` 20000, `OFF_T` 30000,
 * `BLOB` 40000), and `CURLoption` and `CURLMoption` use the same encoding -
 * which is what lets one name serve both handle kinds. An info constant packs
 * its category into the high nibbles under `CURLINFO_TYPEMASK`. So the
 * constant, taken as a template argument, is enough to say what the call has
 * to be given, and to say it at compile time.
 *
 * That is what these wrappers do, and the vararg call each of them makes is
 * the only one left in the engine. The `NOLINT` lives here, once, on the
 * `curl_error_buffer.hpp` pattern: a primitive owning a rule, rather than the
 * ~120 per-site suppressions the alternative reading of that check is.
 *
 * **Why only the Windows leg ever reported this.** libcurl 8.21 wraps all
 * three names in macros - but not the type-checking ones, whose guard reads
 * `!defined(__cplusplus)` ("the typechecker does not work in C++ (yet)"). What
 * C++ gets is `curl_exactly_three_arguments`, an arity check, and it is
 * defined only `#if defined(__STDC__) && (__STDC__ >= 1)`. GCC and Clang
 * define `__STDC__`; MSVC does not, absent `/Za`. So on Linux the call sits
 * inside a macro from a system header and clang-tidy attributes the finding
 * there and drops it, while on Windows the very same source is a plain call
 * the check reports - the ~85 findings #1022 surfaced the first time this leg
 * ran whole-file. A local run reproduces the Windows reading exactly by
 * knocking that macro out: `clang-tidy --extra-arg=-U__STDC__`.
 *
 * **Cost.** None. Each wrapper is a header-inline forward to the same libcurl
 * call with the same arguments; the `if constexpr` picks one branch at compile
 * time and the casts are on constants the site already spelled. The load
 * path's per-transfer setup (`curl_utils.cpp`) emits the instructions it
 * emitted before.
 */

#include <curl/curl.h>

#include <cstddef>
#include <type_traits>

namespace vayu::http {

namespace curl_detail {

/// The argument category libcurl expects for an option constant, per the
/// `CURLOPTTYPE_<category> + index` encoding `CURLoption` and `CURLMoption`
/// share.
constexpr long option_category (long option) {
    return option / 10'000 * 10'000;
}

/// True for anything libcurl can take through a `void*`-shaped slot: an object
/// pointer, a function pointer, a `curl_slist*`, a literal `nullptr`.
template <typename Value>
constexpr bool is_pointer_like = std::is_pointer_v<Value> ||
std::is_null_pointer_v<Value> || std::is_member_pointer_v<Value> ||
std::is_function_v<std::remove_reference_t<Value>>;

/// The category an info constant asks to be written back through.
constexpr long info_category (long info) {
    return info & CURLINFO_TYPEMASK;
}

/**
 * @brief The type `curl_easy_getinfo` writes through for @p Info's category.
 *
 * Exact, not convertible: libcurl stores through the pointer it is handed, so
 * a `long*` where it writes a `curl_off_t` is a four-byte hole in the caller's
 * frame, not a narrowing conversion. `CURLINFO_PTR` and `CURLINFO_SLIST` share
 * a value, so that category is spelled as "some pointer" rather than a type.
 */
template <long Category> struct info_result {
    static_assert (Category != Category, "unknown CURLINFO category");
};

template <> struct info_result<CURLINFO_STRING> {
    using type = char*;
};

template <> struct info_result<CURLINFO_LONG> {
    using type = long;
};

template <> struct info_result<CURLINFO_DOUBLE> {
    using type = double;
};

template <> struct info_result<CURLINFO_OFF_T> {
    using type = curl_off_t;
};

template <> struct info_result<CURLINFO_SOCKET> {
    using type = curl_socket_t;
};

} // namespace curl_detail

/**
 * @brief Set an easy-handle option, with the argument type the option names.
 *
 * `set_opt<CURLOPT_TIMEOUT_MS> (curl, ms)` - the constant is the template
 * argument, so its category is known here and the value is converted to what
 * libcurl will read rather than promoted to whatever the site happened to
 * write. An integer for a pointer option, or a pointer for a `long` one, is a
 * compile error at the call site.
 */
template <CURLoption Option, typename Value>
CURLcode set_opt (CURL* handle, Value value) {
    constexpr long category = curl_detail::option_category (Option);
    if constexpr (category == CURLOPTTYPE_LONG) {
        static_assert (std::is_integral_v<Value> || std::is_enum_v<Value>,
        "this CURLOPT_ takes a long; pass a number, not a pointer");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_easy_setopt (handle, Option, static_cast<long> (value));
    } else if constexpr (category == CURLOPTTYPE_OFF_T) {
        static_assert (std::is_integral_v<Value> || std::is_enum_v<Value>,
        "this CURLOPT_ takes a curl_off_t; pass a number, not a pointer");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_easy_setopt (handle, Option, static_cast<curl_off_t> (value));
    } else {
        static_assert (curl_detail::is_pointer_like<Value>,
        "this CURLOPT_ takes a pointer; pass one, not a number");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_easy_setopt (handle, Option, value);
    }
}

/**
 * @brief Set a multi-handle option.
 *
 * Same name as the easy-handle setter, because `CURL` and `CURLM` are both
 * `void` and could never have told the two apart - `CURLoption` and
 * `CURLMoption` are distinct enums, so the constant does.
 */
template <CURLMoption Option, typename Value>
CURLMcode set_opt (CURLM* handle, Value value) {
    constexpr long category = curl_detail::option_category (Option);
    if constexpr (category == CURLOPTTYPE_LONG) {
        static_assert (std::is_integral_v<Value> || std::is_enum_v<Value>,
        "this CURLMOPT_ takes a long; pass a number, not a pointer");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_multi_setopt (handle, Option, static_cast<long> (value));
    } else if constexpr (category == CURLOPTTYPE_OFF_T) {
        static_assert (std::is_integral_v<Value> || std::is_enum_v<Value>,
        "this CURLMOPT_ takes a curl_off_t; pass a number, not a pointer");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_multi_setopt (handle, Option, static_cast<curl_off_t> (value));
    } else {
        static_assert (curl_detail::is_pointer_like<Value>,
        "this CURLMOPT_ takes a pointer; pass one, not a number");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_multi_setopt (handle, Option, value);
    }
}

/**
 * @brief Read a transfer statistic back into @p out, which must be the exact
 *        type the info constant is written through.
 *
 * `get_info<CURLINFO_RESPONSE_CODE> (curl, &code)` compiles only if `code` is
 * a `long`. That is the whole point: libcurl stores through this pointer
 * without knowing its type, so "close enough" is a write past the object.
 */
template <CURLINFO Info, typename Out>
CURLcode get_info (CURL* handle, Out* out) {
    constexpr long category = curl_detail::info_category (Info);
    if constexpr (category == CURLINFO_SLIST) {
        // CURLINFO_PTR shares this value, so the category cannot name one
        // type - a `curl_slist*` for a list, a `void*` for the private
        // pointer. Both are pointers, which is as far as the encoding goes.
        static_assert (std::is_pointer_v<Out>,
        "this CURLINFO_ is written back as a pointer; pass the address of one");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_easy_getinfo (handle, Info, out);
    } else {
        static_assert (
        std::is_same_v<Out, typename curl_detail::info_result<category>::type>,
        "this CURLINFO_ is written back as a different type; libcurl stores "
        "through the pointer, so a convertible one is a write past the object");
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
        return curl_easy_getinfo (handle, Info, out);
    }
}

} // namespace vayu::http
