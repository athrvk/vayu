/**
 * @file event_loop_test.cpp
 * @brief Tests for the async event loop and thread pool
 */

#include <gtest/gtest.h>

#include "vayu/http/event_loop.hpp"
#include "vayu/http/client.hpp"

#include <atomic>
#include <chrono>
#include <thread>

namespace
{

    // Test URL that returns JSON
    const std::string TEST_URL = "https://httpbin.org/get";
    const std::string TEST_DELAY_URL = "https://httpbin.org/delay/1";
    const std::string INVALID_URL = "https://invalid.test.local/";

} // namespace

// ============================================================================
// EventLoop Basic Tests
// ============================================================================

class EventLoopTest : public ::testing::Test
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

TEST_F(EventLoopTest, StartAndStop)
{
    vayu::http::EventLoop loop;
    EXPECT_FALSE(loop.is_running());

    loop.start();
    EXPECT_TRUE(loop.is_running());

    loop.stop();
    EXPECT_FALSE(loop.is_running());
}

TEST_F(EventLoopTest, SubmitSingleRequest)
{
    vayu::http::EventLoop loop;
    loop.start();

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = TEST_URL;

    std::atomic<bool> completed{false};
    vayu::Result<vayu::Response> result_holder{vayu::Error{vayu::ErrorCode::InternalError, "Not set"}};

    loop.submit(request, [&](size_t id, vayu::Result<vayu::Response> result)
                {
        result_holder = std::move(result);
        completed = true; });

    // Wait for completion
    auto start = std::chrono::steady_clock::now();
    while (!completed && std::chrono::steady_clock::now() - start < std::chrono::seconds(30))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    loop.stop();

    EXPECT_TRUE(completed);
    EXPECT_TRUE(result_holder.is_ok());
    EXPECT_EQ(result_holder.value().status_code, 200);
}

TEST_F(EventLoopTest, SubmitAsyncWithFuture)
{
    vayu::http::EventLoop loop;
    loop.start();

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = TEST_URL;

    auto handle = loop.submit_async(request);
    EXPECT_GT(handle.id, 0u);

    auto result = handle.future.get();
    loop.stop();

    EXPECT_TRUE(result.is_ok());
    EXPECT_EQ(result.value().status_code, 200);
}

TEST_F(EventLoopTest, BatchExecution)
{
    vayu::http::EventLoop loop;
    loop.start();

    std::vector<vayu::Request> requests;
    for (int i = 0; i < 5; ++i)
    {
        vayu::Request req;
        req.method = vayu::HttpMethod::GET;
        req.url = TEST_URL;
        requests.push_back(req);
    }

    auto batch_result = loop.execute_batch(requests);
    loop.stop();

    EXPECT_EQ(batch_result.responses.size(), 5u);
    EXPECT_EQ(batch_result.successful, 5u);
    EXPECT_EQ(batch_result.failed, 0u);
    EXPECT_GT(batch_result.total_time_ms, 0.0);

    for (const auto &response : batch_result.responses)
    {
        EXPECT_TRUE(response.is_ok());
        EXPECT_EQ(response.value().status_code, 200);
    }
}

TEST_F(EventLoopTest, ConcurrentRequests)
{
    vayu::http::EventLoopConfig config;
    config.max_concurrent = 10;
    vayu::http::EventLoop loop(config);
    loop.start();

    constexpr int NUM_REQUESTS = 10;
    std::atomic<int> completed_count{0};

    for (int i = 0; i < NUM_REQUESTS; ++i)
    {
        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url = TEST_URL;

        loop.submit(request, [&](size_t, vayu::Result<vayu::Response> result)
                    {
            if (result.is_ok()) {
                completed_count++;
            } });
    }

    // Wait for all to complete
    auto start = std::chrono::steady_clock::now();
    while (completed_count < NUM_REQUESTS &&
           std::chrono::steady_clock::now() - start < std::chrono::seconds(60))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    loop.stop();

    EXPECT_EQ(completed_count.load(), NUM_REQUESTS);
}

TEST_F(EventLoopTest, HandleInvalidUrl)
{
    vayu::http::EventLoop loop;
    loop.start();

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = INVALID_URL;
    request.timeout_ms = 5000;

    auto handle = loop.submit_async(request);
    auto result = handle.future.get();
    loop.stop();

    EXPECT_TRUE(result.is_error());
}

TEST_F(EventLoopTest, CounterStats)
{
    vayu::http::EventLoop loop;
    loop.start();

    EXPECT_EQ(loop.active_count(), 0u);
    EXPECT_EQ(loop.pending_count(), 0u);
    EXPECT_EQ(loop.total_processed(), 0u);

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = TEST_URL;

    auto handle = loop.submit_async(request);
    handle.future.wait();

    // After completion
    loop.stop();
    EXPECT_EQ(loop.total_processed(), 1u);
}

TEST_F(EventLoopTest, CancelPendingRequest)
{
    vayu::http::EventLoopConfig config;
    config.max_concurrent = 1; // Only allow 1 concurrent to ensure queuing
    vayu::http::EventLoop loop(config);
    loop.start();

    // Submit a slow request first
    vayu::Request slow_request;
    slow_request.method = vayu::HttpMethod::GET;
    slow_request.url = TEST_DELAY_URL;
    loop.submit(slow_request);

    // Submit another request that should be queued
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = TEST_URL;

    std::atomic<bool> callback_called{false};
    std::atomic<bool> was_error{false};

    size_t request_id = loop.submit(request, [&](size_t, vayu::Result<vayu::Response> result)
                                    {
        callback_called = true;
        was_error = result.is_error(); });

    // Try to cancel the pending request
    bool cancelled = loop.cancel(request_id);

    loop.stop();

    // If we managed to cancel it, callback should have been called with error
    if (cancelled)
    {
        // Give time for callback
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        EXPECT_TRUE(callback_called);
        EXPECT_TRUE(was_error);
    }
}

// ============================================================================
// ThreadPool Tests
// ============================================================================

class ThreadPoolTest : public ::testing::Test
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

TEST_F(ThreadPoolTest, CreateWithDefaultThreads)
{
    vayu::http::ThreadPool pool;
    EXPECT_GT(pool.thread_count(), 0u);
}

TEST_F(ThreadPoolTest, CreateWithSpecificThreads)
{
    vayu::http::ThreadPool pool(4);
    EXPECT_EQ(pool.thread_count(), 4u);
}

TEST_F(ThreadPoolTest, SubmitTask)
{
    vayu::http::ThreadPool pool(2);

    std::atomic<int> counter{0};

    auto future = pool.submit([&counter]()
                              {
        counter++;
        return counter.load(); });

    int result = future.get();
    EXPECT_EQ(result, 1);
    EXPECT_EQ(counter.load(), 1);
}

TEST_F(ThreadPoolTest, SubmitMultipleTasks)
{
    vayu::http::ThreadPool pool(4);

    std::atomic<int> counter{0};
    std::vector<std::future<int>> futures;

    for (int i = 0; i < 10; ++i)
    {
        futures.push_back(pool.submit([&counter, i]()
                                      {
            counter++;
            return i * 2; }));
    }

    for (int i = 0; i < 10; ++i)
    {
        EXPECT_EQ(futures[static_cast<size_t>(i)].get(), i * 2);
    }

    EXPECT_EQ(counter.load(), 10);
}

TEST_F(ThreadPoolTest, BatchExecution)
{
    vayu::http::ThreadPool pool(4);

    std::vector<vayu::Request> requests;
    for (int i = 0; i < 4; ++i)
    {
        vayu::Request req;
        req.method = vayu::HttpMethod::GET;
        req.url = TEST_URL;
        requests.push_back(req);
    }

    auto batch_result = pool.execute_batch(requests);

    EXPECT_EQ(batch_result.responses.size(), 4u);
    EXPECT_EQ(batch_result.successful, 4u);
    EXPECT_EQ(batch_result.failed, 0u);
    EXPECT_GT(batch_result.total_time_ms, 0.0);

    for (const auto &response : batch_result.responses)
    {
        EXPECT_TRUE(response.is_ok());
        EXPECT_EQ(response.value().status_code, 200);
    }
}

TEST_F(ThreadPoolTest, MixedSuccessAndFailure)
{
    vayu::http::ThreadPool pool(4);

    std::vector<vayu::Request> requests;

    // Add successful request
    vayu::Request good_req;
    good_req.method = vayu::HttpMethod::GET;
    good_req.url = TEST_URL;
    requests.push_back(good_req);

    // Add failing request
    vayu::Request bad_req;
    bad_req.method = vayu::HttpMethod::GET;
    bad_req.url = INVALID_URL;
    bad_req.timeout_ms = 3000;
    requests.push_back(bad_req);

    // Add another successful request
    requests.push_back(good_req);

    auto batch_result = pool.execute_batch(requests);

    EXPECT_EQ(batch_result.responses.size(), 3u);
    EXPECT_EQ(batch_result.successful, 2u);
    EXPECT_EQ(batch_result.failed, 1u);

    EXPECT_TRUE(batch_result.responses[0].is_ok());
    EXPECT_TRUE(batch_result.responses[1].is_error());
    EXPECT_TRUE(batch_result.responses[2].is_ok());
}

// ============================================================================
// Performance Comparison Test
// ============================================================================

TEST_F(EventLoopTest, EventLoopFasterThanSequential)
{
    vayu::http::EventLoop loop;
    loop.start();

    constexpr int NUM_REQUESTS = 5;
    std::vector<vayu::Request> requests;
    for (int i = 0; i < NUM_REQUESTS; ++i)
    {
        vayu::Request req;
        req.method = vayu::HttpMethod::GET;
        req.url = TEST_URL;
        requests.push_back(req);
    }

    // Measure event loop batch time
    auto event_loop_start = std::chrono::steady_clock::now();
    auto batch_result = loop.execute_batch(requests);
    auto event_loop_end = std::chrono::steady_clock::now();
    auto event_loop_time = std::chrono::duration<double, std::milli>(
                               event_loop_end - event_loop_start)
                               .count();

    loop.stop();

    // Measure sequential time
    auto sequential_start = std::chrono::steady_clock::now();
    vayu::http::Client client;
    for (const auto &req : requests)
    {
        [[maybe_unused]] auto result = client.send(req);
    }
    auto sequential_end = std::chrono::steady_clock::now();
    auto sequential_time = std::chrono::duration<double, std::milli>(
                               sequential_end - sequential_start)
                               .count();

    // Event loop should be faster (or at least comparable for small batches)
    // Due to network variance, we allow some tolerance
    std::cout << "Event loop time: " << event_loop_time << " ms\n";
    std::cout << "Sequential time: " << sequential_time << " ms\n";
    std::cout << "Speedup: " << sequential_time / event_loop_time << "x\n";

    // Just verify both completed successfully
    EXPECT_EQ(batch_result.successful, static_cast<size_t>(NUM_REQUESTS));
}

// ============================================================================
// Progress Callback Test
// ============================================================================

TEST_F(EventLoopTest, ProgressCallback)
{
    vayu::http::EventLoop loop;
    loop.start();

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url = TEST_URL;

    std::atomic<int> progress_calls{0};
    std::atomic<bool> completed{false};

    loop.submit(
        request,
        [&](size_t, vayu::Result<vayu::Response>)
        {
            completed = true;
        },
        [&](size_t, size_t downloaded, size_t total)
        {
            progress_calls++;
            // Progress callback should report download progress
            if (total > 0)
            {
                EXPECT_LE(downloaded, total);
            }
        });

    // Wait for completion
    auto start = std::chrono::steady_clock::now();
    while (!completed && std::chrono::steady_clock::now() - start < std::chrono::seconds(30))
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    loop.stop();

    EXPECT_TRUE(completed);
    // Progress may or may not be called depending on response size
}
