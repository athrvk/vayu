#pragma once

/**
 * @file http/sse.hpp
 * @brief Server-Sent Events (SSE) client for real-time streaming
 *
 * Implements the EventSource API for receiving server-sent events.
 * See: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

#include "vayu/types.hpp"
#include "vayu/core/constants.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>

namespace vayu::http
{

    /**
     * @brief Callback types for EventSource
     */
    using SseEvent = vayu::SseEvent;
    using EventSourceState = vayu::EventSourceState;

    using OnEventCallback = std::function<void(const SseEvent &event)>;
    using OnOpenCallback = std::function<void()>;
    using OnErrorCallback = std::function<void(const Error &error)>;
    using OnStateChangeCallback = std::function<void(EventSourceState state)>;

    /**
     * @brief EventSource configuration
     */
    struct EventSourceConfig
    {
        /// Request headers to send
        Headers headers;

        /// Whether to automatically reconnect on disconnect
        bool auto_reconnect = true;

        /// Initial retry interval in milliseconds (may be overridden by server)
        int retry_ms = 3000;

        /// Maximum retry interval in milliseconds
        int max_retry_ms = vayu::core::constants::sse::MAX_RETRY_MS;

        /// Connection timeout in milliseconds
        int connect_timeout_ms = vayu::core::constants::sse::CONNECT_TIMEOUT_MS;

        /// Whether to send Last-Event-ID on reconnect
        bool send_last_event_id = vayu::core::constants::sse::SEND_LAST_EVENT_ID;

        /// User agent string
        std::string user_agent = vayu::core::constants::defaults::DEFAULT_USER_AGENT;
    };

    /**
     * @brief EventSource for receiving Server-Sent Events
     *
     * Provides a streaming connection to an SSE endpoint with automatic
     * reconnection and event parsing.
     *
     * Example usage:
     * @code
     * EventSource source("https://api.example.com/events");
     *
     * source.on_event([](const SseEvent& event) {
     *     std::cout << "Event: " << event.type << "\n";
     *     std::cout << "Data: " << event.data << "\n";
     * });
     *
     * source.on_open([]() {
     *     std::cout << "Connected!\n";
     * });
     *
     * source.on_error([](const Error& error) {
     *     std::cerr << "Error: " << error.message << "\n";
     * });
     *
     * source.connect();
     *
     * // ... later
     * source.close();
     * @endcode
     */
    class EventSource
    {
    public:
        /**
         * @brief Construct an EventSource for the given URL
         */
        explicit EventSource(std::string url, EventSourceConfig config = {});

        /**
         * @brief Destructor - closes the connection
         */
        ~EventSource();

        // Non-copyable
        EventSource(const EventSource &) = delete;
        EventSource &operator=(const EventSource &) = delete;

        // Movable
        EventSource(EventSource &&) noexcept;
        EventSource &operator=(EventSource &&) noexcept;

        /**
         * @brief Start the connection
         *
         * This spawns a background thread to receive events.
         * Events will be delivered via the registered callbacks.
         */
        void connect();

        /**
         * @brief Close the connection
         *
         * Stops receiving events and closes the HTTP connection.
         * Does not call reconnect even if auto_reconnect is enabled.
         */
        void close();

        /**
         * @brief Get the current connection state
         */
        [[nodiscard]] EventSourceState state() const;

        /**
         * @brief Get the connection URL
         */
        [[nodiscard]] const std::string &url() const;

        /**
         * @brief Get the last event ID received
         */
        [[nodiscard]] std::optional<std::string> last_event_id() const;

        /**
         * @brief Register callback for all events
         *
         * This callback is invoked for every event received.
         */
        void on_event(OnEventCallback callback);

        /**
         * @brief Register callback for a specific event type
         *
         * @param event_type The event type to listen for
         * @param callback The callback to invoke
         */
        void on(const std::string &event_type, OnEventCallback callback);

        /**
         * @brief Register callback for connection open
         */
        void on_open(OnOpenCallback callback);

        /**
         * @brief Register callback for errors
         */
        void on_error(OnErrorCallback callback);

        /**
         * @brief Register callback for state changes
         */
        void on_state_change(OnStateChangeCallback callback);

    private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };

    /**
     * @brief SSE event parser
     *
     * Parses Server-Sent Events from a stream of data.
     * Call feed() with chunks of data as they arrive.
     */
    class SseParser
    {
    public:
        /**
         * @brief Callback for parsed events
         */
        using EventCallback = std::function<void(SseEvent event)>;

        /**
         * @brief Construct a parser with an event callback
         */
        explicit SseParser(EventCallback callback);

        /**
         * @brief Feed data to the parser
         *
         * May trigger zero or more event callbacks.
         *
         * @param data Chunk of data from the stream
         */
        void feed(const std::string &data);

        /**
         * @brief Feed data to the parser
         *
         * @param data Pointer to data
         * @param size Size of data
         */
        void feed(const char *data, size_t size);

        /**
         * @brief Reset the parser state
         */
        void reset();

        /**
         * @brief Get the last event ID seen
         */
        [[nodiscard]] std::optional<std::string> last_event_id() const;

        /**
         * @brief Get the retry interval (if server specified one)
         */
        [[nodiscard]] std::optional<int> retry_ms() const;

    private:
        void process_line(const std::string &line);
        void dispatch_event();

        EventCallback callback_;
        std::string buffer_;
        std::string event_type_;
        std::string event_data_;
        std::optional<std::string> event_id_;
        std::optional<std::string> last_event_id_;
        std::optional<int> retry_ms_;
    };

} // namespace vayu::http
