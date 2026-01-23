#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <functional>
#include <future>
#include <memory>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::http {

/**
 * @brief Traditional thread pool for blocking HTTP operations
 *
 * Unlike EventLoop which uses async curl_multi, ThreadPool uses
 * one thread per concurrent request with blocking I/O.
 * Useful for simpler use cases or when async I/O isn't needed.
 */
class ThreadPool {
    public:
    explicit ThreadPool (size_t num_threads = 0);
    ~ThreadPool ();

    /**
     * @brief Submit a task that returns a value
     */
    template <typename F, typename... Args>
    auto submit (F&& f, Args&&... args) -> std::future<decltype (f (args...))> {
        using return_type = decltype (f (args...));

        auto task = std::make_shared<std::packaged_task<return_type ()>> (
        std::bind (std::forward<F> (f), std::forward<Args> (args)...));

        std::future<return_type> result = task->get_future ();
        submit_impl ([task] () { (*task) (); });
        return result;
    }

    /**
     * @brief Execute a batch of requests using the thread pool
     */
    BatchResult execute_batch (const std::vector<Request>& requests);

    size_t thread_count () const;
    size_t queue_size () const;

    private:
    void submit_impl (std::function<void ()> task);

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace vayu::http
