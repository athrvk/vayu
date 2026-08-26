#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/curl_error_buffer.hpp
 * @brief The buffer libcurl writes a transfer's error text into (issue #945).
 *
 * `CURLOPT_ERRORBUFFER` has three rules and no way to state them: the buffer
 * must hold at least `CURL_ERROR_SIZE` bytes, it must outlive the transfer, and
 * libcurl leaves it *untouched* when nothing goes wrong - so a handle reused
 * across transfers reports the previous failure unless something clears it in
 * between. All three drivers here (the single-request client, the event loop,
 * the SSE stream) spelled it as a bare `char[CURL_ERROR_SIZE]`, which decays to
 * a pointer at every use and carries none of that with it; the size then had to
 * be restated, and "empty means no message" was re-derived at each read as
 * `error_buffer[0]`.
 *
 * This keeps the length attached to the storage and says the contract once. It
 * is deliberately not a `std::string`: libcurl needs somewhere fixed to write
 * into for the whole transfer, and a string that reallocates is exactly what
 * that option cannot be given.
 */

#include <curl/curl.h>

#include <array>
#include <string_view>

namespace vayu::http {

class CurlErrorBuffer {
    public:
    /**
     * @brief Clear the buffer and give @p curl somewhere to write its next
     *        failure.
     *
     * Clearing is the point of doing both together: libcurl only ever writes on
     * failure, so a handle that is reused would otherwise answer a later
     * transfer's success with an earlier transfer's message.
     */
    void attach (CURL* curl) {
        clear ();
        curl_easy_setopt (curl, CURLOPT_ERRORBUFFER, storage_.data ());
    }

    /// Forget any message, leaving the buffer attached where it already is.
    void clear () {
        storage_.fill ('\0');
    }

    /// What libcurl wrote, empty when it wrote nothing.
    [[nodiscard]] std::string_view message () const {
        return { storage_.data () };
    }

    private:
    /// NUL-terminated by libcurl, which never writes more than
    /// `CURL_ERROR_SIZE` bytes including the terminator.
    std::array<char, CURL_ERROR_SIZE> storage_{};
};

} // namespace vayu::http
