// High-performance mock server for benchmarking Vayu
// Responds instantly with minimal latency to test true throughput capacity
//
// Usage: go run mock-server.go
// Default port: 8080
// Endpoints:
//   GET  /health     - Health check (instant response)
//   GET  /fast       - Fast endpoint (~0ms latency)
//   GET  /slow/:ms   - Configurable delay (e.g., /slow/100 for 100ms)
//   POST /echo       - Echo back request body
//   GET  /stats      - Show request statistics

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var (
	totalRequests   int64
	totalLatencyNs  int64
	startTime       time.Time
	requestsPerPath = make(map[string]*int64)
)

func main() {
	port := flag.Int("port", 8080, "Server port")
	flag.Parse()

	startTime = time.Now()

	// Use all available CPU cores
	runtime.GOMAXPROCS(runtime.NumCPU())

	mux := http.NewServeMux()

	// Health check - instant response
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy","service":"mock-server"}`))

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	//echo string
	mux.HandleFunc("/string", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`hello world`))

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	// Fast endpoint - minimal processing
	mux.HandleFunc("/fast", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	// Slow endpoint - configurable delay
	mux.HandleFunc("/slow/", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)

		// Extract delay from path: /slow/100 -> 100ms
		parts := strings.Split(r.URL.Path, "/")
		delayMs := 100 // default
		if len(parts) >= 3 {
			if d, err := strconv.Atoi(parts[2]); err == nil {
				delayMs = d
			}
		}

		time.Sleep(time.Duration(delayMs) * time.Millisecond)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"ok":true,"delay_ms":%d}`, delayMs)

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	// Echo endpoint - returns request body
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)

		if r.Body != nil {
			buf := make([]byte, 1024)
			n, _ := r.Body.Read(buf)
			if n > 0 {
				w.Write(buf[:n])
			} else {
				w.Write([]byte(`{"echo":"empty"}`))
			}
		}

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	// Stats endpoint - show performance metrics
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		total := atomic.LoadInt64(&totalRequests)
		latencyNs := atomic.LoadInt64(&totalLatencyNs)
		uptime := time.Since(startTime).Seconds()

		avgLatencyUs := float64(0)
		if total > 0 {
			avgLatencyUs = float64(latencyNs) / float64(total) / 1000.0
		}

		rps := float64(0)
		if uptime > 0 {
			rps = float64(total) / uptime
		}

		stats := map[string]interface{}{
			"total_requests":   total,
			"uptime_seconds":   uptime,
			"avg_latency_us":   avgLatencyUs,
			"requests_per_sec": rps,
			"cpu_cores":        runtime.NumCPU(),
			"goroutines":       runtime.NumGoroutine(),
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	})

	// Reset stats
	mux.HandleFunc("/reset", func(w http.ResponseWriter, r *http.Request) {
		atomic.StoreInt64(&totalRequests, 0)
		atomic.StoreInt64(&totalLatencyNs, 0)
		startTime = time.Now()

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"reset":true}`))
	})

	// Catch-all for any other path
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		atomic.AddInt64(&totalRequests, 1)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true,"path":"` + r.URL.Path + `"}`))

		atomic.AddInt64(&totalLatencyNs, time.Since(start).Nanoseconds())
	})

	server := &http.Server{
		Addr:           fmt.Sprintf(":%d", *port),
		Handler:        mux,
		ReadTimeout:    5 * time.Second,
		WriteTimeout:   5 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	// Print startup info
	fmt.Printf("╔══════════════════════════════════════════════════════════════╗\n")
	fmt.Printf("║           High-Performance Mock Server for Vayu              ║\n")
	fmt.Printf("╠══════════════════════════════════════════════════════════════╣\n")
	fmt.Printf("║  Port:      %-48d ║\n", *port)
	fmt.Printf("║  CPU Cores: %-48d ║\n", runtime.NumCPU())
	fmt.Printf("║  PID:       %-48d ║\n", os.Getpid())
	fmt.Printf("╠══════════════════════════════════════════════════════════════╣\n")
	fmt.Printf("║  Endpoints:                                                  ║\n")
	fmt.Printf("║    GET  /health  - Health check (instant)                    ║\n")
	fmt.Printf("║    GET  /fast    - Fast response (~0ms)                      ║\n")
	fmt.Printf("║    GET  /slow/N  - Delayed response (N ms)                   ║\n")
	fmt.Printf("║    POST /echo    - Echo request body                         ║\n")
	fmt.Printf("║    GET  /stats   - Performance statistics                    ║\n")
	fmt.Printf("║    GET  /reset   - Reset statistics                          ║\n")
	fmt.Printf("╠══════════════════════════════════════════════════════════════╣\n")
	fmt.Printf("║  Test with: curl http://localhost:%d/health                 ║\n", *port)
	fmt.Printf("╚══════════════════════════════════════════════════════════════╝\n")

	log.Fatal(server.ListenAndServe())
}
