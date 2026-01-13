# Troubleshooting Vayu Desktop

This guide covers common issues when building and running Vayu Desktop.

## Table of Contents

- [Build Issues](#build-issues)
- [Runtime Issues](#runtime-issues)
- [Engine Issues](#engine-issues)
- [Performance Issues](#performance-issues)

## Build Issues

### vcpkg not found

**Error:**
```
vcpkg not found. Install: https://vcpkg.io/en/getting-started.html
```

**Solution:**
```bash
# Install vcpkg
brew install vcpkg

# Or manually
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh
sudo ln -s $(pwd)/vcpkg /usr/local/bin/vcpkg
```

### CMake version too old

**Error:**
```
CMake 3.25 or higher is required
```

**Solution:**
```bash
# macOS
brew install cmake

# Or download from https://cmake.org/download/
```

### Ninja not found

**Error:**
```
ninja: command not found
```

**Solution:**
```bash
brew install ninja
```

### pnpm not found

**Error:**
```
pnpm: command not found
```

**Solution:**
```bash
npm install -g pnpm
```

### Dependency installation fails

**Error:**
```
error: failed to install dependencies
```

**Solution:**
```bash
# Clear vcpkg cache and retry
rm -rf ~/.cache/vcpkg
vcpkg remove --outdated
./scripts/build-engine-macos.sh
```

### TypeScript compilation errors

**Error:**
```
TS2307: Cannot find module './sidecar'
```

**Solution:**
```bash
cd app
pnpm install
pnpm run electron:compile
```

## Runtime Issues

### Engine binary not found (Development)

**Error:**
```
Engine binary not found at: ../engine/build/vayu-engine
```

**Solution:**
```bash
# Build the engine
cd engine
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 8

# Or use the script
cd ..
./scripts/build-app-dev.sh
```

### Engine binary not found (Production)

**Error:**
```
Engine binary not found at: <path>/Resources/bin/vayu-engine
```

**Solution:**
```bash
# Rebuild production binary
./scripts/build-engine-macos.sh

# Verify it exists
ls -la app/resources/bin/vayu-engine

# Rebuild the app
./scripts/build-app-prod.sh
```

### Port 9876 already in use

**Error:**
```
[Sidecar] Engine error: Address already in use
```

**Solution:**
```bash
# Find and kill the process
lsof -i :9876
kill -9 <PID>

# Or use a different port
# Edit app/electron/main.ts and change:
# const sidecar = new EngineSidecar(9877);
```

### Failed to create data directory

**Error:**
```
Error: Failed to create directory: <path> - Permission denied
```

**Solution:**
```bash
# Check permissions on parent directory
ls -la ~/Library/Application\ Support/

# Fix permissions
chmod 755 ~/Library/Application\ Support/

# Or run with sudo (not recommended)
```

### Engine crashes on startup

**Error:**
```
[Sidecar] Engine exited with code 1
```

**Solution:**
```bash
# Check logs
cat ~/Library/Application\ Support/vayu-desktop/logs/vayu_*.log

# Common causes:
# 1. Database corruption
rm ~/Library/Application\ Support/vayu-desktop/db/vayu.db

# 2. Lock file left from crashed instance
rm ~/Library/Application\ Support/vayu-desktop/vayu.lock
```

## Engine Issues

### Database initialization failed

**Error:**
```
Failed to initialize database: unable to open database file
```

**Solution:**
```bash
# Ensure data directory exists
mkdir -p ~/Library/Application\ Support/vayu-desktop/db

# Check permissions
chmod 755 ~/Library/Application\ Support/vayu-desktop
chmod 755 ~/Library/Application\ Support/vayu-desktop/db

# Delete corrupted database
rm ~/Library/Application\ Support/vayu-desktop/db/vayu.db
```

### Lock file error

**Error:**
```
Error: Another instance of Vayu Engine is already running
```

**Solution:**
```bash
# Check if engine is actually running
ps aux | grep vayu-engine

# If not running, remove stale lock file
rm ~/Library/Application\ Support/vayu-desktop/vayu.lock

# If running, kill it first
pkill vayu-engine
```

### Engine not responding

**Symptoms:** UI shows "connecting..." but never connects

**Solution:**
```bash
# Check if engine is running
ps aux | grep vayu-engine

# Check if port is listening
lsof -i :9876

# Test health endpoint manually
curl http://127.0.0.1:9876/health

# Check engine logs
cat ~/Library/Application\ Support/vayu-desktop/logs/vayu_*.log
```

### SSL/TLS errors

**Error:**
```
curl error 60: SSL certificate problem
```

**Solution:**
```bash
# Update system certificates
brew upgrade openssl

# Or disable SSL verification (development only)
# Edit your request to include:
# "verify_ssl": false
```

## Performance Issues

### Slow request execution

**Symptoms:** Requests take much longer than expected

**Checklist:**
1. **DNS resolution:** First request to a domain is slower (DNS lookup)
2. **Connection pooling:** Enable keep-alive headers
3. **Target server:** Problem might be on the server side
4. **Network:** Check your internet connection

**Solution:**
```bash
# Enable debug logging
# In app, set verbose mode or check logs:
cat ~/Library/Application\ Support/vayu-desktop/logs/vayu_*.log

# Test with curl to compare
curl -w "@curl-format.txt" -o /dev/null -s https://example.com
```

### High CPU usage

**Symptoms:** Fan running, battery draining fast

**Solution:**
```bash
# Check if engine is stuck in a loop
ps aux | grep vayu-engine

# Check active load tests
curl http://127.0.0.1:9876/runs

# Stop all active tests via UI or API
curl -X POST http://127.0.0.1:9876/run/<id>/stop
```

### High memory usage

**Symptoms:** App uses multiple GB of RAM

**Causes:**
- Large response bodies stored in memory
- Long-running load tests
- Memory leak (please report!)

**Solution:**
```bash
# Stop active tests
# Restart the app

# Report the issue with:
# - Memory usage screenshot
# - Test configuration
# - Response sizes
```

## Electron Issues

### White screen on launch

**Symptoms:** App opens but shows blank white screen

**Solution:**
```bash
# Open DevTools (Development)
# Cmd+Option+I

# Check for JavaScript errors in Console
# Check Network tab for failed requests

# Common causes:
# 1. Vite dev server not running (dev mode)
# 2. Build failed (production mode)
# 3. Missing dist files
```

### DevTools won't open

**Symptoms:** Cmd+Option+I does nothing

**Solution:**
```bash
# Edit app/electron/main.ts
# Ensure this line exists in createWindow():
mainWindow.webContents.openDevTools();
```

### Hot reload not working

**Symptoms:** Changes to React code don't appear

**Solution:**
```bash
# Restart Vite dev server
# Ctrl+C in the terminal running electron:dev
# Run again:
cd app
pnpm run electron:dev
```

## macOS-Specific Issues

### "App is damaged and can't be opened"

**Error:** Gatekeeper blocks the app

**Solution:**
```bash
# Remove quarantine attribute
xattr -d com.apple.quarantine /Applications/Vayu\ Desktop.app

# Or allow in System Settings:
# System Settings > Privacy & Security > Allow apps from: App Store and identified developers
```

### "Vayu Desktop" wants to access files

**Symptoms:** Permission dialogs on every launch

**Solution:**
```bash
# Grant Full Disk Access:
# System Settings > Privacy & Security > Full Disk Access
# Add Vayu Desktop

# Or grant specific folder access as prompted
```

### Rosetta required (Intel Mac)

**Error:** "Vayu Desktop requires Rosetta"

**Solution:**
```bash
# Install Rosetta 2
softwareupdate --install-rosetta
```

## Getting Help

If you're still stuck:

1. **Check logs:**
   - App logs: `~/Library/Application Support/vayu-desktop/logs/`
   - Console.app: Filter by "Vayu"

2. **Search issues:** [GitHub Issues](https://github.com/vayu/vayu/issues)

3. **Ask for help:**
   - [Create an issue](https://github.com/vayu/vayu/issues/new)
   - Include:
     - macOS version
     - Vayu version
     - Error messages
     - Relevant logs
     - Steps to reproduce

4. **Debug mode:**
   ```bash
   # Run engine with verbose logging
   ./vayu-engine --verbose 2 --data-dir ~/vayu-debug
   
   # Run Electron with debugging
   NODE_ENV=development pnpm run electron:dev
   ```

## Common Workflows

### Clean rebuild

```bash
# Clean everything
rm -rf engine/build*
rm -rf app/node_modules
rm -rf app/dist*
rm -rf app/release

# Rebuild from scratch
./scripts/build-app-dev.sh
cd app && pnpm run electron:dev
```

### Reset app data

```bash
# Backup first (optional)
cp -r ~/Library/Application\ Support/vayu-desktop ~/vayu-backup

# Remove all app data
rm -rf ~/Library/Application\ Support/vayu-desktop

# App will recreate on next launch
```

### Update dependencies

```bash
# Update vcpkg packages
cd engine
vcpkg update
vcpkg upgrade

# Update npm packages
cd ../app
pnpm update

# Rebuild
cd ..
./scripts/build-app-prod.sh
```
