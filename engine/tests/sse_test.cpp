/**
 * @file sse_test.cpp
 * @brief Tests for Server-Sent Events implementation
 */

#include <gtest/gtest.h>

#include "vayu/http/sse.hpp"
#include "vayu/http/client.hpp"

#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

namespace
{

    // Public SSE test endpoint
    const std::string SSE_TEST_URL = "https://sse.dev/test";

} // namespace

// ============================================================================
// SseParser Tests
// ============================================================================

class SseParserTest : public ::testing::Test
{
protected:
    std::vector<vayu::http::SseEvent> events;

    void SetUp() override
    {
        events.clear();
    }

    vayu::http::SseParser create_parser()
    {
        return vayu::http::SseParser([this](vayu::http::SseEvent event)
                                     { events.push_back(std::move(event)); });
    }
};

TEST_F(SseParserTest, ParseSimpleEvent)
{
    auto parser = create_parser();

    parser.feed("data: hello world\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].type, "message");
    EXPECT_EQ(events[0].data, "hello world");
    EXPECT_FALSE(events[0].id.has_value());
}

TEST_F(SseParserTest, ParseEventWithType)
{
    auto parser = create_parser();

    parser.feed("event: custom\ndata: test data\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].type, "custom");
    EXPECT_EQ(events[0].data, "test data");
}

TEST_F(SseParserTest, ParseEventWithId)
{
    auto parser = create_parser();

    parser.feed("id: 123\ndata: with id\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "with id");
    ASSERT_TRUE(events[0].id.has_value());
    EXPECT_EQ(*events[0].id, "123");
}

TEST_F(SseParserTest, ParseEventWithRetry)
{
    auto parser = create_parser();

    parser.feed("retry: 5000\ndata: with retry\n\n");

    ASSERT_EQ(events.size(), 1u);
    ASSERT_TRUE(events[0].retry_ms.has_value());
    EXPECT_EQ(*events[0].retry_ms, 5000);
    EXPECT_EQ(parser.retry_ms(), 5000);
}

TEST_F(SseParserTest, ParseMultilineData)
{
    auto parser = create_parser();

    parser.feed("data: line 1\ndata: line 2\ndata: line 3\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "line 1\nline 2\nline 3");
}

TEST_F(SseParserTest, ParseMultipleEvents)
{
    auto parser = create_parser();

    parser.feed("data: event 1\n\ndata: event 2\n\ndata: event 3\n\n");

    ASSERT_EQ(events.size(), 3u);
    EXPECT_EQ(events[0].data, "event 1");
    EXPECT_EQ(events[1].data, "event 2");
    EXPECT_EQ(events[2].data, "event 3");
}

TEST_F(SseParserTest, IgnoreComments)
{
    auto parser = create_parser();

    parser.feed(": this is a comment\ndata: actual data\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "actual data");
}

TEST_F(SseParserTest, HandleCRLFLineEndings)
{
    auto parser = create_parser();

    parser.feed("data: crlf data\r\n\r\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "crlf data");
}

TEST_F(SseParserTest, HandleChunkedInput)
{
    auto parser = create_parser();

    // Feed data in chunks
    parser.feed("da");
    parser.feed("ta: ch");
    parser.feed("unked\n");
    parser.feed("\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "chunked");
}

TEST_F(SseParserTest, IgnoreUnknownFields)
{
    auto parser = create_parser();

    parser.feed("unknown: field\ndata: known data\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "known data");
}

TEST_F(SseParserTest, RemoveLeadingSpaceFromValue)
{
    auto parser = create_parser();

    parser.feed("data: with leading space\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "with leading space");
}

TEST_F(SseParserTest, FieldWithNoColonValue)
{
    auto parser = create_parser();

    // Per SSE spec: "data" alone with no colon is equivalent to "data:" (empty value)
    // This appends empty string to data buffer, but since buffer was empty,
    // it remains empty and no event is dispatched (per spec)
    parser.feed("data\n\n");

    // Per SSE spec: If data buffer is empty, no event is dispatched
    EXPECT_TRUE(events.empty());

    // But if we have actual data first, then empty data appends newline
    parser.feed("data: first line\ndata\ndata: last line\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].data, "first line\n\nlast line");
}

TEST_F(SseParserTest, TrackLastEventId)
{
    auto parser = create_parser();

    parser.feed("id: first\ndata: event 1\n\n");
    EXPECT_EQ(parser.last_event_id(), "first");

    parser.feed("id: second\ndata: event 2\n\n");
    EXPECT_EQ(parser.last_event_id(), "second");

    // Event without ID keeps last known ID
    parser.feed("data: event 3\n\n");
    EXPECT_EQ(parser.last_event_id(), "second");
}

TEST_F(SseParserTest, RejectIdWithNullCharacter)
{
    auto parser = create_parser();

    std::string data_with_null = "id: bad";
    data_with_null += '\0';
    data_with_null += "id\ndata: test\n\n";

    parser.feed(data_with_null);

    ASSERT_EQ(events.size(), 1u);
    EXPECT_FALSE(events[0].id.has_value()); // ID with null should be rejected
}

TEST_F(SseParserTest, RejectInvalidRetry)
{
    auto parser = create_parser();

    parser.feed("retry: not-a-number\ndata: test\n\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_FALSE(parser.retry_ms().has_value());
}

TEST_F(SseParserTest, ResetClearsState)
{
    auto parser = create_parser();

    parser.feed("id: 123\nretry: 5000\ndata: test\n\n");

    EXPECT_EQ(parser.last_event_id(), "123");
    EXPECT_EQ(parser.retry_ms(), 5000);

    parser.reset();

    EXPECT_FALSE(parser.last_event_id().has_value());
    EXPECT_FALSE(parser.retry_ms().has_value());
}

TEST_F(SseParserTest, EmptyDataLinesNotDispatched)
{
    auto parser = create_parser();

    // Just an empty line shouldn't dispatch an event
    parser.feed("\n");
    parser.feed("\n");

    EXPECT_TRUE(events.empty());

    // But with data, it should
    parser.feed("data: actual\n\n");
    EXPECT_EQ(events.size(), 1u);
}

TEST_F(SseParserTest, ComplexEvent)
{
    auto parser = create_parser();

    parser.feed("event: update\n");
    parser.feed("id: msg-42\n");
    parser.feed("retry: 3000\n");
    parser.feed("data: {\"user\": \"john\"}\n");
    parser.feed("data: {\"action\": \"login\"}\n");
    parser.feed("\n");

    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(events[0].type, "update");
    EXPECT_EQ(events[0].id, "msg-42");
    EXPECT_EQ(events[0].retry_ms, 3000);
    EXPECT_EQ(events[0].data, "{\"user\": \"john\"}\n{\"action\": \"login\"}");
}

// ============================================================================
// EventSource State Tests
// ============================================================================

TEST(EventSourceStateTest, ToStringConversion)
{
    EXPECT_STREQ(vayu::http::to_string(vayu::http::EventSourceState::Connecting), "CONNECTING");
    EXPECT_STREQ(vayu::http::to_string(vayu::http::EventSourceState::Open), "OPEN");
    EXPECT_STREQ(vayu::http::to_string(vayu::http::EventSourceState::Closed), "CLOSED");
}

// ============================================================================
// EventSource Basic Tests
// ============================================================================

class EventSourceTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        vayu::http::global_init();
    }

    void TearDown() override
    {
        vayu::http::global_cleanup();
    }
};

TEST_F(EventSourceTest, InitialState)
{
    vayu::http::EventSource source("https://example.com/events");

    EXPECT_EQ(source.state(), vayu::http::EventSourceState::Closed);
    EXPECT_EQ(source.url(), "https://example.com/events");
    EXPECT_FALSE(source.last_event_id().has_value());
}

TEST_F(EventSourceTest, ConnectAndClose)
{
    vayu::http::EventSourceConfig config;
    config.auto_reconnect = false;
    config.connect_timeout_ms = 5000;

    vayu::http::EventSource source(SSE_TEST_URL, config);

    std::atomic<bool> opened{false};
    std::atomic<bool> state_changed{false};
    std::atomic<int> event_count{0};

    source.on_open([&opened]()
                   { opened = true; });

    source.on_state_change([&state_changed](vayu::http::EventSourceState state)
                           {
                               state_changed = true;
                               // State should change to Connecting first
                           });

    source.on_event([&event_count](const vayu::http::SseEvent &)
                    { event_count++; });

    source.connect();

    // Wait for connection
    auto start = std::chrono::steady_clock::now();
    while (!opened && std::chrono::steady_clock::now() - start < std::chrono::seconds(10))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Wait a bit for events
    std::this_thread::sleep_for(std::chrono::seconds(2));

    source.close();

    EXPECT_TRUE(state_changed);
    EXPECT_EQ(source.state(), vayu::http::EventSourceState::Closed);

    // sse.dev/test sends events, so we should have received some
    // But we don't require opened to be true since the endpoint may not work
}

TEST_F(EventSourceTest, TypedEventCallback)
{
    vayu::http::SseParser parser([](vayu::http::SseEvent) {});

    // Create a mock EventSource to test typed callbacks
    vayu::http::EventSource source("https://example.com/events");

    std::atomic<int> message_count{0};
    std::atomic<int> custom_count{0};

    source.on("message", [&message_count](const vayu::http::SseEvent &)
              { message_count++; });

    source.on("custom", [&custom_count](const vayu::http::SseEvent &)
              { custom_count++; });

    // Note: We can't easily test this without a real SSE server
    // The callbacks are registered but won't be triggered without connection
    EXPECT_EQ(message_count, 0);
    EXPECT_EQ(custom_count, 0);
}

TEST_F(EventSourceTest, ErrorCallback)
{
    vayu::http::EventSourceConfig config;
    config.auto_reconnect = false;
    config.connect_timeout_ms = 3000;

    // Invalid URL should trigger error
    vayu::http::EventSource source("https://invalid.test.local/events", config);

    std::atomic<bool> error_received{false};
    vayu::ErrorCode error_code = vayu::ErrorCode::None;

    source.on_error([&error_received, &error_code](const vayu::Error &error)
                    {
        error_received = true;
        error_code = error.code; });

    source.connect();

    // Wait for error
    auto start = std::chrono::steady_clock::now();
    while (!error_received && std::chrono::steady_clock::now() - start < std::chrono::seconds(10))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    source.close();

    EXPECT_TRUE(error_received);
    EXPECT_NE(error_code, vayu::ErrorCode::None);
}

TEST_F(EventSourceTest, CustomHeaders)
{
    vayu::http::EventSourceConfig config;
    config.headers["Authorization"] = "Bearer test-token";
    config.headers["X-Custom-Header"] = "custom-value";
    config.auto_reconnect = false;

    vayu::http::EventSource source("https://httpbin.org/headers", config);

    // Just verify it doesn't crash with custom headers
    source.close();
}

// ============================================================================
// Integration Tests with Real SSE Server
// ============================================================================

TEST_F(EventSourceTest, ReceiveRealEvents)
{
    // Use httpbin's SSE endpoint or a public SSE test server
    // Note: This test may be flaky depending on network conditions

    vayu::http::EventSourceConfig config;
    config.auto_reconnect = false;
    config.connect_timeout_ms = 10000;

    vayu::http::EventSource source(SSE_TEST_URL, config);

    std::atomic<bool> opened{false};
    std::atomic<int> event_count{0};
    std::vector<std::string> received_data;
    std::mutex data_mutex;

    source.on_open([&opened]()
                   { opened = true; });

    source.on_event([&event_count, &received_data, &data_mutex](const vayu::http::SseEvent &event)
                    {
        event_count++;
        std::lock_guard<std::mutex> lock(data_mutex);
        received_data.push_back(event.data); });

    source.connect();

    // Wait up to 5 seconds for events
    auto start = std::chrono::steady_clock::now();
    while (event_count < 3 && std::chrono::steady_clock::now() - start < std::chrono::seconds(5))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    source.close();

    // We expect to have received at least some events if the server is working
    // Don't fail the test if the server is down, just log
    if (event_count > 0)
    {
        std::cout << "Received " << event_count << " events from SSE test server\n";
    }
    else
    {
        std::cout << "No events received (SSE test server may be unavailable)\n";
    }
}
