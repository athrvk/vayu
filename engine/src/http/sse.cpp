/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse.cpp
 * @brief Server-Sent Events implementation
 */

#include "vayu/http/sse.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <unordered_map>

#include "vayu/core/constants.hpp"

namespace vayu::http {

// ============================================================================
// SseParser Implementation
// ============================================================================

SseParser::SseParser (EventCallback callback)
: callback_ (std::move (callback)) {
}

void SseParser::feed (const std::string& data) {
    feed (data.data (), data.size ());
}

void SseParser::feed (const char* data, size_t size) {
    buffer_.append (data, size);

    // Process complete lines
    size_t pos = 0;
    while (pos < buffer_.size ()) {
        // Find end of line (CR, LF, or CRLF)
        size_t eol = buffer_.find_first_of (vayu::core::constants::http::EOL_CHARS, pos);
        if (eol == std::string::npos) {
            // No complete line yet
            break;
        }

        std::string line = buffer_.substr (pos, eol - pos);

        // Skip over line ending
        if (eol < buffer_.size () && buffer_[eol] == '\r') {
            eol++;
        }
        if (eol < buffer_.size () && buffer_[eol] == '\n') {
            eol++;
        }

        pos = eol;

        process_line (line);
    }

    // Remove processed data from buffer
    if (pos > 0) {
        buffer_.erase (0, pos);
    }
}

void SseParser::process_line (const std::string& line) {
    // Empty line = dispatch event
    if (line.empty ()) {
        dispatch_event ();
        return;
    }

    // Comment (starts with colon)
    if (line[0] == ':') {
        // Ignore comments, but they can be used as keep-alive
        return;
    }

    // Parse field: value
    size_t colon_pos = line.find (':');
    std::string field;
    std::string value;

    if (colon_pos == std::string::npos) {
        // Field with no value
        field = line;
    } else {
        field = line.substr (0, colon_pos);
        value = line.substr (colon_pos + 1);

        // Remove leading space from value (per spec)
        if (!value.empty () && value[0] == ' ') {
            value.erase (0, 1);
        }
    }

    // Process known fields
    if (field == "event") {
        event_type_ = value;
    } else if (field == "data") {
        // Per spec: Append value, then append newline to buffer
        // We track this by adding newline before each subsequent data line
        if (!event_data_.empty ()) {
            event_data_ += '\n';
        }
        event_data_ += value;
    } else if (field == "id") {
        // ID must not contain null characters
        if (value.find ('\0') == std::string::npos) {
            event_id_ = value;
        }
    } else if (field == "retry") {
        // Parse as integer
        try {
            int retry_val = std::stoi (value);
            if (retry_val >= 0) {
                retry_ms_ = retry_val;
            }
        } catch (...) {
            // Ignore invalid retry values
        }
    }
    // Unknown fields are ignored per spec
}

void SseParser::dispatch_event () {
    // Only dispatch if we have data (per SSE spec)
    if (event_data_.empty ()) {
        // Reset event state
        event_type_.clear ();
        event_id_.reset ();
        return;
    }

    // Update last event ID
    if (event_id_) {
        last_event_id_ = event_id_;
    }

    // Create and dispatch event
    SseEvent event;
    event.type     = event_type_.empty () ? "message" : event_type_;
    event.data     = std::move (event_data_);
    event.id       = event_id_;
    event.retry_ms = retry_ms_;

    if (callback_) {
        callback_ (std::move (event));
    }

    // Reset event state (but keep last_event_id_ and retry_ms_)
    event_type_.clear ();
    event_data_.clear ();
    event_id_.reset ();
}

void SseParser::reset () {
    buffer_.clear ();
    event_type_.clear ();
    event_data_.clear ();
    event_id_.reset ();
    last_event_id_.reset ();
    retry_ms_.reset ();
}

std::optional<std::string> SseParser::last_event_id () const {
    return last_event_id_;
}

std::optional<int> SseParser::retry_ms () const {
    return retry_ms_;
}

// ============================================================================
// EventSource Implementation
// ============================================================================

struct EventSource::Impl {
    std::string url;
    EventSourceConfig config;
    std::atomic<EventSourceState> state{ EventSourceState::Closed };

    // Callbacks
    OnEventCallback on_event_callback;
    std::unordered_map<std::string, OnEventCallback> typed_callbacks;
    OnOpenCallback on_open_callback;
    OnErrorCallback on_error_callback;
    OnStateChangeCallback on_state_change_callback;
    std::mutex callback_mutex;

    // Connection state
    CURL* curl = nullptr;
    std::thread worker_thread;
    std::atomic<bool> should_close{ false };
    std::optional<std::string> last_event_id;
    int current_retry_ms;

    // Parser
    std::unique_ptr<SseParser> parser;

    Impl (std::string url_, EventSourceConfig config_)
    : url (std::move (url_)), config (std::move (config_)),
      current_retry_ms (config.retry_ms) {
    }

    ~Impl () {
        close ();
    }

    void set_state (EventSourceState new_state) {
        EventSourceState old_state = state.exchange (new_state);
        if (old_state != new_state) {
            std::lock_guard<std::mutex> lock (callback_mutex);
            if (on_state_change_callback) {
                on_state_change_callback (new_state);
            }
        }
    }

    void dispatch_event (const SseEvent& event) {
        std::lock_guard<std::mutex> lock (callback_mutex);

        // Update last event ID
        if (event.id) {
            last_event_id = event.id;
        }

        // Update retry interval
        if (event.retry_ms) {
            current_retry_ms = std::min (*event.retry_ms, config.max_retry_ms);
        }

        // Call general event callback
        if (on_event_callback) {
            on_event_callback (event);
        }

        // Call typed callback
        auto it = typed_callbacks.find (event.type);
        if (it != typed_callbacks.end () && it->second) {
            it->second (event);
        }
    }

    void dispatch_error (const Error& error) {
        std::lock_guard<std::mutex> lock (callback_mutex);
        if (on_error_callback) {
            on_error_callback (error);
        }
    }

    void dispatch_open () {
        std::lock_guard<std::mutex> lock (callback_mutex);
        if (on_open_callback) {
            on_open_callback ();
        }
    }

    static size_t write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
        auto* impl        = static_cast<Impl*> (userdata);
        size_t total_size = size * nmemb;

        if (impl->should_close) {
            return 0; // Abort transfer
        }

        // Feed data to parser
        impl->parser->feed (ptr, total_size);

        return total_size;
    }

    static size_t header_callback (char* buffer, size_t size, size_t nitems, void* /*userdata*/) {
        size_t total_size = size * nitems;

        // Check for successful response and correct content type
        std::string header (buffer, total_size);

        // Detect when we've received headers (status line)
        if (header.starts_with ("HTTP/")) {
            // Connection established
        }

        return total_size;
    }

    void run_connection () {
        bool first_attempt = true;

        while (!should_close) {
            if (!first_attempt && config.auto_reconnect) {
                // Wait before reconnecting
                std::this_thread::sleep_for (std::chrono::milliseconds (current_retry_ms));

                // Exponential backoff (capped at max_retry_ms)
                current_retry_ms = std::min (current_retry_ms * 2, config.max_retry_ms);

                if (should_close) {
                    break;
                }
            }

            first_attempt = false;
            set_state (EventSourceState::Connecting);

            // Reset parser
            parser = std::make_unique<SseParser> (
            [this] (SseEvent event) { dispatch_event (event); });

            // Setup curl
            curl = curl_easy_init ();
            if (!curl) {
                Error error;
                error.code    = ErrorCode::InternalError;
                error.message = "Failed to initialize curl";
                dispatch_error (error);
                break;
            }

            // Set URL
            curl_easy_setopt (curl, CURLOPT_URL, url.c_str ());

            // Set callbacks
            curl_easy_setopt (curl, CURLOPT_WRITEFUNCTION, write_callback);
            curl_easy_setopt (curl, CURLOPT_WRITEDATA, this);
            curl_easy_setopt (curl, CURLOPT_HEADERFUNCTION, header_callback);
            curl_easy_setopt (curl, CURLOPT_HEADERDATA, this);

            // Build headers
            struct curl_slist* headers_list = nullptr;

            // Accept text/event-stream
            headers_list = curl_slist_append (headers_list, "Accept: text/event-stream");

            // Cache-Control: no-cache
            headers_list = curl_slist_append (headers_list, "Cache-Control: no-cache");

            // User agent
            std::string ua_header = "User-Agent: " + config.user_agent;
            headers_list = curl_slist_append (headers_list, ua_header.c_str ());

            // Last-Event-ID for reconnection
            if (config.send_last_event_id && last_event_id) {
                std::string id_header = "Last-Event-ID: " + *last_event_id;
                headers_list = curl_slist_append (headers_list, id_header.c_str ());
            }

            // Custom headers
            for (const auto& [key, value] : config.headers) {
                std::string header = key + ": " + value;
                headers_list = curl_slist_append (headers_list, header.c_str ());
            }

            curl_easy_setopt (curl, CURLOPT_HTTPHEADER, headers_list);

            // Connection timeout
            curl_easy_setopt (curl, CURLOPT_CONNECTTIMEOUT_MS,
            static_cast<long> (config.connect_timeout_ms));

            // No timeout on transfer (streaming)
            curl_easy_setopt (curl, CURLOPT_TIMEOUT, 0L);

            // Follow redirects
            curl_easy_setopt (curl, CURLOPT_FOLLOWLOCATION, 1L);

            // SSL verification
            curl_easy_setopt (curl, CURLOPT_SSL_VERIFYPEER, 1L);
            curl_easy_setopt (curl, CURLOPT_SSL_VERIFYHOST, 2L);

            // Perform request
            CURLcode res = curl_easy_perform (curl);

            // Check response code before dispatching open
            if (res == CURLE_OK) {
                long http_code = 0;
                curl_easy_getinfo (curl, CURLINFO_RESPONSE_CODE, &http_code);

                if (http_code == 200) {
                    // Only dispatch open on first successful connection
                    if (state == EventSourceState::Connecting) {
                        set_state (EventSourceState::Open);
                        dispatch_open ();
                        // Reset retry on successful connection
                        current_retry_ms = config.retry_ms;
                    }
                }
            }

            // Cleanup
            curl_slist_free_all (headers_list);
            curl_easy_cleanup (curl);
            curl = nullptr;

            if (should_close) {
                break;
            }

            // Handle errors
            if (res != CURLE_OK) {
                Error error;
                error.message = curl_easy_strerror (res);

                switch (res) {
                case CURLE_OPERATION_TIMEDOUT:
                    error.code = ErrorCode::Timeout;
                    break;
                case CURLE_COULDNT_CONNECT:
                case CURLE_COULDNT_RESOLVE_HOST:
                    error.code = ErrorCode::ConnectionFailed;
                    break;
                case CURLE_SSL_CONNECT_ERROR:
                case CURLE_SSL_CERTPROBLEM:
                    error.code = ErrorCode::SslError;
                    break;
                default: error.code = ErrorCode::InternalError; break;
                }

                dispatch_error (error);
            }

            // If auto_reconnect is disabled, stop
            if (!config.auto_reconnect) {
                break;
            }
        }

        set_state (EventSourceState::Closed);
    }

    void connect () {
        if (state != EventSourceState::Closed) {
            return; // Already connected or connecting
        }

        should_close  = false;
        worker_thread = std::thread (&Impl::run_connection, this);
    }

    void close () {
        should_close = true;

        // Abort any ongoing transfer
        if (curl) {
            // The write callback will return 0 and abort
        }

        if (worker_thread.joinable ()) {
            worker_thread.join ();
        }
    }
};

EventSource::EventSource (std::string url, EventSourceConfig config)
: impl_ (std::make_unique<Impl> (std::move (url), std::move (config))) {
}

EventSource::~EventSource () = default;

EventSource::EventSource (EventSource&&) noexcept            = default;
EventSource& EventSource::operator= (EventSource&&) noexcept = default;

void EventSource::connect () {
    impl_->connect ();
}

void EventSource::close () {
    impl_->close ();
}

EventSourceState EventSource::state () const {
    return impl_->state;
}

const std::string& EventSource::url () const {
    return impl_->url;
}

std::optional<std::string> EventSource::last_event_id () const {
    return impl_->last_event_id;
}

void EventSource::on_event (OnEventCallback callback) {
    std::lock_guard<std::mutex> lock (impl_->callback_mutex);
    impl_->on_event_callback = std::move (callback);
}

void EventSource::on (const std::string& event_type, OnEventCallback callback) {
    std::lock_guard<std::mutex> lock (impl_->callback_mutex);
    impl_->typed_callbacks[event_type] = std::move (callback);
}

void EventSource::on_open (OnOpenCallback callback) {
    std::lock_guard<std::mutex> lock (impl_->callback_mutex);
    impl_->on_open_callback = std::move (callback);
}

void EventSource::on_error (OnErrorCallback callback) {
    std::lock_guard<std::mutex> lock (impl_->callback_mutex);
    impl_->on_error_callback = std::move (callback);
}

void EventSource::on_state_change (OnStateChangeCallback callback) {
    std::lock_guard<std::mutex> lock (impl_->callback_mutex);
    impl_->on_state_change_callback = std::move (callback);
}

} // namespace vayu::http
