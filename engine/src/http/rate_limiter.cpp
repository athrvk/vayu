#include "vayu/http/rate_limiter.hpp"

#include <algorithm>
#include <thread>

#include "vayu/core/constants.hpp"

namespace vayu::http {
RateLimiter::RateLimiter(RateLimiterConfig config)
    : config_(std::move(config)), tokens_(0.0), last_refill_(std::chrono::steady_clock::now()) {
    // Set default burst size if not specified
    if (config_.burst_size == 0.0 && config_.target_rps > 0.0) {
        config_.burst_size = config_.target_rps * vayu::core::constants::http::BURST_MULTIPLIER;
    }

    // Start with full burst capacity
    tokens_ = config_.burst_size;
}

void RateLimiter::refill_tokens() {
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration<double>(now - last_refill_).count();

    // Add tokens based on elapsed time and target RPS
    double new_tokens = elapsed * config_.target_rps;
    tokens_ = std::min(tokens_ + new_tokens, config_.burst_size);

    last_refill_ = now;
}

void RateLimiter::acquire() {
    if (!config_.enabled()) {
        return;
    }

    std::unique_lock<std::mutex> lock(mutex_);

    while (true) {
        refill_tokens();

        if (tokens_ >= vayu::core::constants::http::TOKEN_COST) {
            tokens_ -= vayu::core::constants::http::TOKEN_COST;
            return;
        }

        // Calculate how long to wait for next token
        double tokens_needed = 1.0 - tokens_;
        double wait_seconds = tokens_needed / config_.target_rps;

        lock.unlock();
        std::this_thread::sleep_for(std::chrono::duration<double>(wait_seconds));
        lock.lock();
    }
}

bool RateLimiter::try_acquire() {
    if (!config_.enabled()) {
        return true;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    refill_tokens();

    if (tokens_ >= 1.0) {
        tokens_ -= 1.0;
        return true;
    }

    return false;
}

bool RateLimiter::try_acquire_unlocked() {
    if (!config_.enabled()) {
        return true;
    }

    // No lock - caller guarantees single-threaded access
    refill_tokens();

    if (tokens_ >= 1.0) {
        tokens_ -= 1.0;
        return true;
    }

    return false;
}

void RateLimiter::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    tokens_ = config_.burst_size;
    last_refill_ = std::chrono::steady_clock::now();
}

double RateLimiter::available_tokens() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return tokens_;
}

}  // namespace vayu::http
