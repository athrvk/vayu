#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <atomic>
#include <cassert>
#include <concepts>
#include <cstddef>
#include <memory>
#include <new>
#include <type_traits>
#include <vector>

namespace vayu::core {

/**
 * @brief High-performance Single-Producer Single-Consumer Lock-Free Queue
 *
 * Designed for passing ownership of objects (like std::unique_ptr) between threads
 * with minimal overhead. Uses a ring buffer with atomic head/tail indices.
 *
 * @tparam T Type of elements (must be movable)
 */
template <typename T> class SPSCQueue {
    public:
    explicit SPSCQueue (size_t capacity) : capacity_ (capacity) {
        // Ensure capacity is power of 2 for fast bitwise masking
        if (capacity_ < 2 || (capacity_ & (capacity_ - 1)) != 0) {
            // Find next power of 2
            size_t next_pow2 = 1;
            while (next_pow2 < capacity_)
                next_pow2 <<= 1;
            capacity_ = next_pow2;
        }
        mask_ = capacity_ - 1;
        buffer_.resize (capacity_);
    }

    ~SPSCQueue () = default;

    // Non-copyable/movable
    SPSCQueue (const SPSCQueue&)            = delete;
    SPSCQueue& operator= (const SPSCQueue&) = delete;
    SPSCQueue (SPSCQueue&&)                 = delete;
    SPSCQueue& operator= (SPSCQueue&&)      = delete;

    /**
     * @brief Enqueue an item
     * @return true if successful, false if queue is full
     * @note Only callable from Producer thread.
     *       If successful, `item` is moved-from.
     *       If failure, `item` is left unchanged.
     */
    bool push (T& item) {
        const size_t head      = head_.load (std::memory_order_relaxed);
        const size_t next_head = (head + 1) & mask_;

        if (next_head == tail_.load (std::memory_order_acquire)) {
            return false;
        }

        buffer_[head] = std::move (item);
        head_.store (next_head, std::memory_order_release);
        return true;
    }

    /**
     * @brief Dequeue an item
     * @return true if successful, false if queue is empty
     * @note Only callable from Consumer thread
     */
    bool pop (T& item) {
        const size_t tail = tail_.load (std::memory_order_relaxed);

        if (tail == head_.load (std::memory_order_acquire)) {
            return false;
        }

        item = std::move (buffer_[tail]);
        tail_.store ((tail + 1) & mask_, std::memory_order_release);
        return true;
    }

    /**
     * @brief Check if queue is empty
     * @note Safe to call from Consumer, approximate from Producer
     */
    bool empty () const {
        return head_.load (std::memory_order_acquire) ==
        tail_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Get buffer current size (items available to read)
     */
    size_t size () const {
        size_t head = head_.load (std::memory_order_acquire);
        size_t tail = tail_.load (std::memory_order_acquire); // Use acquire for safety across threads
        if (head >= tail)
            return head - tail;
        return capacity_ + head - tail;
    }

    /**
     * @brief Alias for size(), clear intent for consumer
     */
    size_t read_available () const {
        return size ();
    }

    private:
    // Cache-line alignment to prevent false sharing
    alignas (64) std::atomic<size_t> head_{ 0 };
    alignas (64) std::atomic<size_t> tail_{ 0 };

    // Constant after construction
    size_t capacity_;
    size_t mask_;
    std::vector<T> buffer_;
};

} // namespace vayu::core
