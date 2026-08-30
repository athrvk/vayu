#pragma once

/**
 * @file task_queue.hpp
 * @brief The one place a test says how big its mock server's thread pool is.
 *
 * Every in-process mock here overrides httplib's default task queue, because
 * the default is sized for a demo and these tests hold tens of concurrent
 * transfers open at once - a thread-starved mock serializes them and makes
 * teardown take tens of seconds, which reads as engine latency and is a harness
 * artifact. Seven fixtures wrote that override themselves before this existed,
 * and a copy of a primitive does not receive the primitive's fixes.
 *
 * The `new` is httplib's contract, not a leak: `Server::new_task_queue` is a
 * factory the server calls once per `listen()`, and the server deletes what it
 * gets back (`httplib::Server::stop`/`~Server`). A `unique_ptr` cannot be
 * returned here - the hook's signature is `std::function<TaskQueue*()>` - which
 * is why `cppcoreguidelines-owning-memory` is silenced with that reason once,
 * here, rather than at each fixture that used to spell the `new` itself.
 */

#include <httplib.h>

#include <atomic>
#include <cstddef>
#include <functional>
#include <memory>
#include <utility>

namespace vayu::tests {

/**
 * @brief An httplib `new_task_queue` factory for a pool of @p threads workers.
 *
 * Assign it: `svr.new_task_queue = vayu::tests::pooled_task_queue (16);`
 */
inline std::function<httplib::TaskQueue*()> pooled_task_queue (std::size_t threads) {
    return [threads] () -> httplib::TaskQueue* {
        // httplib owns and deletes what this factory returns; see the file
        // comment above.
        // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
        return new httplib::ThreadPool (threads);
    };
}

namespace detail {

/**
 * @brief Holds a mock server's live-connection count up for one task.
 *
 * A guard rather than a pair of statements, so a handler that throws past
 * httplib cannot leave the count high for the rest of the test.
 */
class ConnectionScope {
    public:
    explicit ConnectionScope (std::shared_ptr<std::atomic<int>> live)
    : live_ (std::move (live)) {
        live_->fetch_add (1, std::memory_order_relaxed);
    }
    ~ConnectionScope () {
        live_->fetch_sub (1, std::memory_order_relaxed);
    }
    ConnectionScope (const ConnectionScope&)            = delete;
    ConnectionScope& operator= (const ConnectionScope&) = delete;
    ConnectionScope (ConnectionScope&&)                 = delete;
    ConnectionScope& operator= (ConnectionScope&&)      = delete;

    private:
    std::shared_ptr<std::atomic<int>> live_;
};

/**
 * @brief A pooled task queue that also counts the connections open right now.
 *
 * httplib runs a whole connection - its accept, every keep-alive request on it,
 * and its close - as ONE queued task, so tasks in flight is exactly the number
 * of connections the server is holding open. `httplib::ThreadPool` is `final`,
 * so this wraps one instead of deriving from it.
 */
class CountingTaskQueue final : public httplib::TaskQueue {
    public:
    CountingTaskQueue (std::size_t threads, std::shared_ptr<std::atomic<int>> live)
    : pool_ (threads), live_ (std::move (live)) {
    }
    ~CountingTaskQueue () override                          = default;
    CountingTaskQueue (const CountingTaskQueue&)            = delete;
    CountingTaskQueue& operator= (const CountingTaskQueue&) = delete;
    CountingTaskQueue (CountingTaskQueue&&)                 = delete;
    CountingTaskQueue& operator= (CountingTaskQueue&&)      = delete;

    bool enqueue (std::function<void ()> fn) override {
        return pool_.enqueue ([live = live_, task = std::move (fn)] () {
            const ConnectionScope open (live);
            task ();
        });
    }

    void shutdown () override {
        pool_.shutdown ();
    }

    private:
    httplib::ThreadPool pool_;
    std::shared_ptr<std::atomic<int>> live_;
};

} // namespace detail

/**
 * @brief `pooled_task_queue`, with @p live tracking the connections held open.
 *
 * The count is a `shared_ptr` because httplib owns the queue and shuts it down
 * from inside `listen()`; a counter borrowed from the fixture would outlive its
 * reader only by luck.
 */
inline std::function<httplib::TaskQueue*()>
counting_task_queue (std::size_t threads, std::shared_ptr<std::atomic<int>> live) {
    return [threads, live = std::move (live)] () -> httplib::TaskQueue* {
        // httplib owns and deletes what this factory returns; see the file
        // comment above.
        // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
        return new detail::CountingTaskQueue (threads, live);
    };
}

} // namespace vayu::tests
