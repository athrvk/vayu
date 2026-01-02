# Vayu Documentation

Welcome to the Vayu documentation. Choose a topic to get started.

---

## 📚 Documentation Structure

### 🏢 Overall Project

| Document | Description |
|----------|-------------|
| [Getting Started](getting-started.md) | Installation and first steps |
| [Architecture](architecture.md) | System design and sidecar pattern |
| [Contributing Guide](contributing.md) | How to contribute to Vayu |

### 🖥️ Engine Documentation

Core C++20 engine implementation and CLI tools.

| Document | Description |
|----------|-------------|
| [CLI Reference](engine/cli.md) | vayu-cli command reference and usage |
| [Building Engine](engine/building.md) | Compile the engine from source |
| [Engine API Reference](engine/api-reference.md) | HTTP Control API endpoints (daemon) |
| [Engine Architecture](engine/architecture.md) | Internal engine components and design |

### 📱 App Documentation  

Electron/React manager application.

| Document | Description |
|----------|-------------|
| [Building App](app/building.md) | Compile the manager application |
| [UI Architecture](app/architecture.md) | Manager UI structure |
| [Postman Migration](app/postman-migration.md) | Move from Postman to Vayu |

---

## Quick Links

- **GitHub:** [github.com/vayu/vayu](https://github.com/vayu/vayu)
- **Releases:** [GitHub Releases](https://github.com/vayu/vayu/releases)
- **Issues:** [Report a Bug](https://github.com/vayu/vayu/issues)
- **Discord:** [Join Community](https://discord.gg/vayu)

---

## Document Map

```
docs/
├── README.md                  ← You are here
├── getting-started.md         ← Start here
├── architecture.md            ← System design
├── contributing.md            ← Contributing
├── engine/
│   ├── cli.md                 ← CLI tool reference
│   ├── building.md            ← Building from source
│   ├── api-reference.md       ← HTTP API endpoints
│   └── architecture.md        ← Engine internals
└── app/
    ├── building.md
    ├── architecture.md
    └── postman-migration.md
```

---

## Next Steps

1. **New User?** Start with [Getting Started](getting-started.md)
2. **Building from Source?** See [Engine Building](engine/building.md) or [App Building](app/building.md)
3. **Understanding the Architecture?** Read [Architecture](architecture.md)
4. **Coming from Postman?** Check [Postman Migration](app/postman-migration.md)

This documentation is for **Vayu v0.1.0** (unreleased).
