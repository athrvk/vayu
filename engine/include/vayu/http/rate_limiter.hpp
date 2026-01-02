#pragma once

#include <chrono>
#include <mutex>

namespace vayu::http
{
    /**
     * @brief Configuration for rate limiting
     */
    struct RateLimiterConfig
    {
        /**
         * @brief Target requests per second
         *
         * Set to 0 to disable rate limiting (unlimited RPS)
         */
        double target_rps = 0.0;

        /**
         * @brief Maximum burst size (tokens that can accumulate)
         *
         * Allows for short bursts above the target RPS.
         * Default is 2x the RPS.
         */
        double burst_size = 0.0;

        /**
         * @brief Whether rate limiting is enabled
         */
        bool enabled() const { return target_rps > 0.0; }
    };

    /**
     * @brief Token bucket rate limiter
     *
     * Implements a token bucket algorithm to limit request rate to a target RPS.
     * - Tokens are added at a constant rate (target_rps)
     * - Each request consumes one token
     * - If no tokens available, request blocks until a token is available
     * - Burst size allows temporary bursts above the target rate
     *
     * Thread-safe for concurrent access from multiple worker threads.
     *
     * Example:
     * @code
     * RateLimiterConfig config;
     * config.target_rps = 10000.0;  // 10k RPS
     * config.burst_size = 20000.0;  // Allow 2x burst
     *
     * RateLimiter limiter(config);
     *
     * // Before each request
     * limiter.acquire();  // Blocks until token available
     * // ... send request ...
     * @endcode
     */
    class RateLimiter
    {
    public:
        /**
         * @brief Construct a rate limiter
         *
         * @param config Rate limiter configuration
         */
        explicit RateLimiter(RateLimiterConfig config = {});

        /**
         * @brief Acquire a token (blocks if necessary)
         *
         * Blocks the calling thread until a token is available.
         * Returns immediately if rate limiting is disabled.
         */
        void acquire();

        /**
         * @brief Try to acquire a token without blocking
         *
         * @return true if token acquired, false if no tokens available
         */
        bool try_acquire();

        /**
         * @brief Reset the rate limiter state
         */
        void reset();

        /**
         * @brief Check if rate limiting is enabled
         */
        bool enabled() const { return config_.enabled(); }

        /**
         * @brief Get current token count (for testing/monitoring)
         */
        double available_tokens() const;

    private:
        void refill_tokens();

        RateLimiterConfig config_;
        mutable std::mutex mutex_;

        double tokens_;
        std::chrono::steady_clock::time_point last_refill_;
    };

} // namespace vayu::http
