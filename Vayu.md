# **Project Design Document: Vayu**

**The High-Performance, Open-Source API Development Platform**

## **1\. The Problem Statement**

**"The Two-Tool Gap"**

In the current API development landscape, engineers are forced to maintain two separate workflows:

1. **Design & Debug:** Using tools like **Postman, Insomnia, or Bruno**. These offer great UI and ease of use (JavaScript assertions) but suffer from **poor performance**. They are single-threaded (Node.js/Electron) and crash under load.  
2. **Load & Stress Test:** Using tools like **k6, JMeter, or Gatling**. These offer immense power (50k+ RPS) but suffer from **poor UX**. They often require learning a new DSL (Go/Lua/XML) and lack visual debugging.

The Pain:  
Developers build a test suite in Postman to verify logic. When they need to verify scale, they must rewrite those tests in k6. This duplication is inefficient and error-prone.

## **2\. The Solution**

**Vayu**: A "Hybrid" API tool that combines the UX of Postman with the raw power of a C++ Game Engine.

* **Design Mode:** A React-based UI for building requests, viewing pretty-printed JSON, and writing JS assertions.  
* **Vayu Mode:** A C++ native engine that takes the *exact same request* and executes it at massive concurrency (50k+ RPS).

**Value Proposition:** "Write once. Debug visually. Scale instantly."

## **3\. High-Level Architecture**

**The "Sidecar" Pattern**

Vayu decouples the User Interface from the Execution Engine.

### **Component A: The Manager (Electron \+ React)**

* **Role:** The "Face". Handles user interaction, file management, and results visualization.  
* **Tech:** Electron, React, TypeScript, Vite, Tailwind CSS.  
* **Responsibility:**  
  * Spawns the C++ Engine process on startup.  
  * Sends commands (JSON) to the Engine via HTTP (Control Plane).  
  * Receives real-time stats (RPS, Latency) via Server-Sent Events (SSE).

### **Component B: The Engine (C++)**

* **Role:** The "Muscle". A headless daemon optimized for raw I/O throughput.  
* **Tech:** C++20.  
* **Core Libraries:**  
  * **Networking:** libcurl (Multi Interface) \- For non-blocking HTTP/1.1, H/2, H/3.  
  * **Scripting:** QuickJS \- For executing user logic (pm.test) inside the C++ loop.  
  * **Server:** cpp-httplib \- For the localhost Control Plane API.  
  * **JSON:** nlohmann/json \- For parsing configuration.

## **4\. Critical Engineering Challenges (The "Focus")**

To succeed, development must prioritize the **Engine**. The UI is standard; the Engine is where the innovation happens.

### **Priority 1: The Concurrency Model (Non-Blocking I/O)**

* **Problem:** We cannot spawn a thread per request (OS limit).  
* **Solution:** Use an **Event-Driven Architecture**.  
  * Create a fixed **Thread Pool** (e.g., matching CPU cores).  
  * Each thread manages a libcurl Multi-Handle (an event loop).  
  * This allows a single thread to manage thousands of open socket connections simultaneously.

### **Priority 2: The Scripting Bridge (The "JS Trap")**

* **Problem:** Postman tests use JavaScript (pm.expect(x).to.be(y)). Running V8 for every request is too slow (memory/startup overhead).  
* **Solution:** **QuickJS \+ Context Pooling**.  
  * Embed the lightweight QuickJS engine.  
  * **Optimization:** Do not create new VM contexts for every request. Maintain a "Pool" of pre-initialized contexts.  
  * **Binding:** Manually bind C++ response objects to the JS pm object so users can access headers/body.

### **Priority 3: Lock-Free Statistics**

* **Problem:** 16 threads updating a global total\_requests counter causes "Mutex Contention," killing performance.  
* **Solution:** **Thread-Local Aggregation**.  
  * Each worker thread maintains its own struct ThreadStats.  
  * A separate "Reporter Thread" wakes up every 100ms to sum these stats and push them to the UI.  
  * **Zero Mutexes** in the hot path.

## **5\. Implementation Roadmap**

### **Phase 1: The "Tracer Bullet" (Engine Prototype)**

**Goal:** Prove C++ can run a Postman script using libcurl \+ QuickJS.

* **Output:** A CLI tool ./vayu-cli run request.json.  
* **Tasks:**  
  1. Setup CMake project with libcurl and QuickJS.  
  2. Implement a simple HTTP GET using curl\_easy.  
  3. Pass the response body to a QuickJS context.  
  4. Expose a C++ function console.log to JS.  
  5. Run a user script: console.log(response.body).

### **Phase 2: The Core Engine (Production Ready)**

**Goal:** Achieve high concurrency (50k RPS) and expose the Control API.

* **Output:** A headless daemon ./vayu-engine.  
* **Tasks:**  
  1. **Event Loop:** Switch from curl\_easy to curl\_multi with a thread pool.  
  2. **API Server:** Integrate cpp-httplib to listen for POST /run.  
  3. **Stats:** Implement the thread-local stats collector.  
  4. **SSE Stream:** Implement the results stream endpoint.

### **Phase 3: The UI Integration (Electron)**

**Goal:** A usable Desktop App.

* **Output:** An installed app Vayu.exe.  
* **Tasks:**  
  1. **Scaffold:** Setup Electron \+ Vite \+ React.  
  2. **Sidecar Logic:** Write Node.js code to spawn/kill the C++ binary.  
  3. **Request Builder:** Build the UI forms (Method, URL, Headers).  
  4. **Runner UI:** Build the Dashboard to visualize the SSE stream from the engine.

### **Phase 4: Polish & Compatibility**

**Goal:** Postman parity.

* **Tasks:**  
  1. **Postman Import:** Write a JSON parser to convert Postman Collections to Vayu format.  
  2. **Environment Variables:** Implement {{variable}} substitution in C++.  
  3. **Packaging:** Configure electron-builder and GitHub Actions for cross-platform releases.

## **6\. Technology Justification**

| Component | Choice | Reason |
| :---- | :---- | :---- |
| **Language** | **C++** | Go is fast, but C++ offers manual memory layout control (critical for the Scripting Bridge and avoiding GC pauses during stats collection). |
| **Network** | **libcurl** | The most battle-tested HTTP library in the world. Supports HTTP/3. Abstractions like Boost.Beast are too complex for MVP. |
| **Scripting** | **QuickJS** | V8 is 20MB and takes 5ms to startup. QuickJS is 500KB and starts in microseconds. Perfect for per-request sandboxing. |
| **UI** | **Electron** | While heavier than native, it provides the fastest path to a "Postman-like" UI using standard React components. |
| **Build** | **CMake** | Industry standard for C++. Essential for managing the dependencies (curl, quickjs, openssl). |

