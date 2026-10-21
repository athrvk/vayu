# vayu_embed_js(<target> <symbol> <file>)
#
# Compiles a vendored JavaScript file into <target> as data: generates
# ${CMAKE_BINARY_DIR}/generated/vayu/embedded/<symbol, lowercased>.hpp, which
# declares `vayu::runtime::embedded::<symbol>`, a constexpr std::string_view
# over the file's bytes, and puts that directory on <target>'s private include
# path. The `require()` shelf (src/runtime/require_shelf.cpp) is the reader.
#
# The header holds a byte array rather than a string literal: MSVC refuses one
# literal over 16,380 bytes (C2026) and a concatenation of them over 65,535
# (C1091), and an array has neither limit. The array ends in a zero byte the
# view leaves out, because JS_Eval reads the byte after the length.
#
# Generated at configure time: the file is a configure dependency, so an edit
# re-runs CMake, and the header is written only when its content changes, so a
# re-configure recompiles nothing. The work is two linear regex passes over the
# file's hex.
function(vayu_embed_js target symbol file)
    if(NOT symbol MATCHES "^[A-Z][A-Z0-9_]*$")
        message(FATAL_ERROR "vayu_embed_js: '${symbol}' is not an UPPER_CASE identifier")
    endif()
    get_filename_component(file "${file}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    if(NOT EXISTS "${file}")
        message(FATAL_ERROR "vayu_embed_js: ${file} does not exist")
    endif()
    file(SIZE "${file}" size)
    if(size EQUAL 0)
        message(FATAL_ERROR "vayu_embed_js: ${file} is empty")
    endif()

    file(READ "${file}" hex HEX)
    # Sixteen bytes to a line, then each byte as a char literal. HEX is
    # lowercase, and a byte above 0x7f is well-formed as '\xNN' since C++23.
    string(REGEX REPLACE "(................................)" "\\1\n" hex "${hex}")
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "'\\\\x\\1'," bytes "${hex}")

    file(RELATIVE_PATH source_name "${PROJECT_SOURCE_DIR}" "${file}")
    set(generated_dir "${CMAKE_BINARY_DIR}/generated")
    string(TOLOWER "${symbol}" stem)
    file(CONFIGURE OUTPUT "${generated_dir}/vayu/embedded/${stem}.hpp" @ONLY CONTENT
"// Generated from ${source_name} by vayu_embed_js (cmake/embed_js.cmake).
// Edit that file, never this one.
#pragma once

#include <string_view>

namespace vayu::runtime::embedded {

namespace detail {
// A built-in array so the compiler counts the bytes: the assert below then
// catches an embed shorter than the file, which a sized std::array would pad.
inline constexpr char ${symbol}_BYTES[] = {
${bytes}'\\0' };
} // namespace detail

/// The bytes of ${source_name}; the terminator after them is not counted.
inline constexpr std::string_view ${symbol}{ detail::${symbol}_BYTES,
sizeof (detail::${symbol}_BYTES) - 1 };

static_assert (${symbol}.size () == ${size} && ${symbol}.data ()[${size}] == '\\0',
\"the embed of ${source_name} is not the whole file\");

} // namespace vayu::runtime::embedded
")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${file}")
    target_include_directories(${target} PRIVATE "${generated_dir}")
endfunction()
