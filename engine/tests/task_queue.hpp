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

#include <cstddef>
#include <functional>

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

} // namespace vayu::tests
