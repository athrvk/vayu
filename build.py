#!/usr/bin/env python3
"""
Vayu Cross-Platform Build Script
Modern unified build system for C++ Engine + Electron App
"""

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional, Tuple, List
import threading

# Global flags
VERBOSE = False
CMAKE_PATH = "cmake"  # Will be updated if found in non-standard location
PNPM_PATH = "pnpm"  # Will be updated if found in non-standard location

# ANSI codes
class Style:
    # Colors
    CYAN = '\033[36m'
    GREEN = '\033[32m'
    YELLOW = '\033[33m'
    RED = '\033[31m'
    BLUE = '\033[34m'
    MAGENTA = '\033[35m'
    GRAY = '\033[90m'
    WHITE = '\033[97m'

    # Styles
    BOLD = '\033[1m'
    DIM = '\033[2m'
    RESET = '\033[0m'

    # Symbols
    ARROW = '→'
    CHECK = '✓'
    CROSS = '✗'
    INFO = 'ℹ'
    WARN = '⚠'
    ROCKET = '▲'
    DOT = '•'
    SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

class Spinner:
    """Simple spinner for long-running operations."""
    def __init__(self, message: str):
        self.message = message
        self.running = False
        self.thread = None

    def _spin(self):
        idx = 0
        while self.running:
            sys.stdout.write(f'\r  {Style.CYAN}{Style.SPINNER[idx]}{Style.RESET} {self.message}')
            sys.stdout.flush()
            time.sleep(0.1)
            idx = (idx + 1) % len(Style.SPINNER)

    def start(self):
        if not VERBOSE:
            self.running = True
            self.thread = threading.Thread(target=self._spin)
            self.thread.start()

    def stop(self, symbol: str = Style.CHECK, color: str = Style.GREEN):
        if not VERBOSE:
            self.running = False
            if self.thread:
                self.thread.join()
            sys.stdout.write(f'\r  {color}{symbol}{Style.RESET} {self.message}\n')
            sys.stdout.flush()

def log(message: str, prefix: str = '', color: str = ''):
    """Simple log with optional prefix and color."""
    if color:
        print(f'  {color}{prefix}{Style.RESET} {message}')
    else:
        print(f'  {prefix} {message}')

def log_dim(message: str):
    """Dimmed log message."""
    print(f'{Style.DIM}    {message}{Style.RESET}')

def print_header():
    """Print modern compact header."""
    print()
    print(f'{Style.BOLD}{Style.CYAN}{Style.ROCKET} Vayu Build{Style.RESET}')
    print()

def print_build_info(mode: str, components: List[str], platform_name: str, verbose: bool):
    """Print build configuration in a clean table."""
    print(f'  {Style.DIM}┌{"─" * 58}┐{Style.RESET}')
    print(f'  {Style.DIM}│{Style.RESET}  {Style.GRAY}Platform{Style.RESET}    {platform_name:<45}{Style.DIM}│{Style.RESET}')
    print(f'  {Style.DIM}│{Style.RESET}  {Style.GRAY}Mode{Style.RESET}        {Style.MAGENTA}{mode}{Style.RESET}{" " * (45 - len(mode))}{Style.DIM}│{Style.RESET}')
    components_str = " + ".join(components)
    print(f'  {Style.DIM}│{Style.RESET}  {Style.GRAY}Components{Style.RESET}  {Style.CYAN}{components_str}{Style.RESET}{" " * (45 - len(components_str))}{Style.DIM}│{Style.RESET}')
    verbose_str = "Yes" if verbose else "No"
    print(f'  {Style.DIM}│{Style.RESET}  {Style.GRAY}Verbose{Style.RESET}     {verbose_str:<45}{Style.DIM}│{Style.RESET}')
    print(f'  {Style.DIM}└{"─" * 58}┘{Style.RESET}')
    print()

def print_step(step: int, total: int, title: str):
    """Print step header."""
    print()
    print(f'  {Style.BOLD}[{step}/{total}] {title}{Style.RESET}')
    print()

def print_success(elapsed: int, artifacts: List[Tuple[str, str]]):
    """Print success message with artifacts."""
    print()
    print(f'  {Style.GREEN}{Style.CHECK} Build complete{Style.RESET} {Style.DIM}({elapsed}s){Style.RESET}')

    if artifacts:
        print()
        print(f'  {Style.BOLD}Artifacts{Style.RESET}')
        print()
        for label, path in artifacts:
            print(f'  {Style.DIM}{Style.ARROW}{Style.RESET} {Style.GRAY}{label}{Style.RESET}')
            print(f'    {Style.CYAN}{path}{Style.RESET}')
    print()

def print_error(message: str):
    """Print error and exit."""
    print()
    print(f'  {Style.RED}{Style.CROSS} {message}{Style.RESET}')
    print()
    sys.exit(1)

def print_command_error(cmd: List[str], exit_code: int, output: str, description: str):
    """Print detailed command error."""
    print()
    print(f'  {Style.RED}{Style.CROSS} {description} failed{Style.RESET}')
    print()
    print(f'  {Style.DIM}Command{Style.RESET}')
    print(f'  {Style.GRAY}$ {" ".join(cmd)}{Style.RESET}')
    print()
    print(f'  {Style.DIM}Exit code: {exit_code}{Style.RESET}')

    if output and not VERBOSE:
        print()
        print(f'  {Style.DIM}Output (last 25 lines){Style.RESET}')
        print()

        lines = output.strip().split('\n')
        display_lines = lines[-25:] if len(lines) > 25 else lines

        for line in display_lines:
            if any(kw in line.lower() for kw in ['error', 'failed', 'fatal']):
                print(f'  {Style.RED}{line}{Style.RESET}')
            else:
                print(f'  {Style.GRAY}{line}{Style.RESET}')

        if len(lines) > 25:
            print()
            print(f'  {Style.DIM}... ({len(lines) - 25} more lines){Style.RESET}')

    print()
    print(f'  {Style.YELLOW}{Style.INFO} Run with {Style.BOLD}-v{Style.RESET}{Style.YELLOW} for full output{Style.RESET}')
    print()

def detect_platform() -> Tuple[str, str]:
    """Detect platform and return (display_name, preset_prefix)."""
    system = platform.system()
    if system == "Windows":
        return ("Windows", "windows")
    elif system == "Linux":
        return ("Linux", "linux")
    elif system == "Darwin":
        return ("macOS", "macos")
    else:
        print_error(f"Unsupported platform: {system}")

def find_visual_studio() -> Optional[str]:
    """Find Visual Studio installation on Windows using vswhere."""
    system_name, _ = detect_platform()
    if system_name != "Windows":
        return None

    vswhere_path = Path(os.environ.get('ProgramFiles(x86)', 'C:\\Program Files (x86)')) / 'Microsoft Visual Studio' / 'Installer' / 'vswhere.exe'

    if not vswhere_path.exists():
        return None

    try:
        # Find VS with VC++ tools
        result = subprocess.run(
            [str(vswhere_path), '-latest', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
            capture_output=True,
            text=True,
            check=True
        )
        vs_path = result.stdout.strip()
        if vs_path and Path(vs_path).exists():
            return vs_path
    except:
        pass

    return None

def find_cmake_windows() -> Optional[str]:
    """Find CMake on Windows (PATH, VS, common locations)."""
    # Check PATH first
    cmake_cmd = shutil.which("cmake")
    if cmake_cmd:
        return cmake_cmd

    # Check Visual Studio
    vs_path = find_visual_studio()
    if vs_path:
        vs_cmake = Path(vs_path) / 'Common7' / 'IDE' / 'CommonExtensions' / 'Microsoft' / 'CMake' / 'CMake' / 'bin' / 'cmake.exe'
        if vs_cmake.exists():
            return str(vs_cmake)

    # Check common paths
    common_paths = [
        Path('C:/Program Files/CMake/bin/cmake.exe'),
        Path('C:/Program Files (x86)/CMake/bin/cmake.exe'),
    ]

    for path in common_paths:
        if path.exists():
            return str(path)

    return None

def find_pnpm_windows() -> Optional[str]:
    """Find pnpm on Windows (PATH, npm global, common locations)."""
    # Check PATH first
    pnpm_cmd = shutil.which("pnpm")
    if pnpm_cmd:
        return pnpm_cmd

    # Check npm's global prefix (where npm installs global packages)
    try:
        result = subprocess.run(
            ["npm", "config", "get", "prefix"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5
        )
        npm_prefix = result.stdout.strip()
        if npm_prefix and npm_prefix != "undefined":
            # pnpm is typically in node_modules/.bin or directly in the prefix
            pnpm_paths = [
                Path(npm_prefix) / "node_modules" / ".bin" / "pnpm.cmd",
                Path(npm_prefix) / "node_modules" / ".bin" / "pnpm",
                Path(npm_prefix) / "pnpm.cmd",
                Path(npm_prefix) / "pnpm",
            ]
            for path in pnpm_paths:
                if path.exists():
                    return str(path)
    except:
        pass

    # Check npm's global directory (alternative method)
    try:
        result = subprocess.run(
            ["npm", "root", "-g"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5
        )
        npm_global = result.stdout.strip()
        if npm_global:
            # pnpm might be in the parent directory's node_modules/.bin
            pnpm_paths = [
                Path(npm_global).parent / "node_modules" / ".bin" / "pnpm.cmd",
                Path(npm_global).parent / "node_modules" / ".bin" / "pnpm",
                Path(npm_global).parent.parent / "node_modules" / ".bin" / "pnpm.cmd",
            ]
            for path in pnpm_paths:
                if path.exists():
                    return str(path)
    except:
        pass

    # Check common npm locations (where npm installs global .cmd wrappers)
    appdata = os.environ.get('APPDATA', '')
    if appdata:
        npm_paths = [
            Path(appdata) / 'npm' / 'pnpm.cmd',
            Path(appdata) / 'npm' / 'pnpm',
        ]
        for path in npm_paths:
            if path.exists():
                return str(path)

    # Check Program Files (Node.js installation directory)
    program_files = os.environ.get('ProgramFiles', 'C:/Program Files')
    nodejs_paths = [
        Path(program_files) / 'nodejs' / 'pnpm.cmd',
        Path(program_files) / 'nodejs' / 'pnpm',
        Path(program_files) / 'nodejs' / 'node_modules' / 'pnpm' / 'bin' / 'pnpm.cmd',
    ]
    for path in nodejs_paths:
        if path.exists():
            return str(path)

    return None

def find_vcpkg_windows() -> Optional[str]:
    """Find vcpkg on Windows (env vars, PATH, VS, common locations)."""
    # Check environment variables first
    for env_var in ["VCPKG_ROOT", "VCPKG_INSTALLATION_ROOT"]:
        vcpkg_root = os.environ.get(env_var)
        if vcpkg_root and Path(vcpkg_root).exists():
            return vcpkg_root

    # Check PATH
    vcpkg_cmd = shutil.which("vcpkg")
    if vcpkg_cmd:
        return str(Path(vcpkg_cmd).parent)

    # Check Visual Studio
    vs_path = find_visual_studio()
    if vs_path:
        vs_vcpkg = Path(vs_path) / 'VC' / 'vcpkg'
        if vs_vcpkg.exists() and (vs_vcpkg / 'vcpkg.exe').exists():
            return str(vs_vcpkg)

    # Check common installation locations
    common_paths = [
        Path('C:/vcpkg'),
        Path('C:/tools/vcpkg'),
        Path(os.path.expanduser('~/vcpkg')),
        Path(os.environ.get('USERPROFILE', '')) / 'vcpkg' if os.environ.get('USERPROFILE') else None,
        Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'vcpkg',
    ]

    for path in common_paths:
        if path and path.exists() and (path / 'vcpkg.exe').exists():
            return str(path)

    return None

def check_tool(name: str, command: List[str]) -> Tuple[bool, str]:
    """Check if a tool is available."""
    global CMAKE_PATH, PNPM_PATH
    system_name, _ = detect_platform()

    # Special handling for CMake on Windows
    if name == "CMake" and system_name == "Windows":
        cmake_path = find_cmake_windows()
        if cmake_path:
            try:
                result = subprocess.run([cmake_path, "--version"], capture_output=True, text=True, check=True)
                version = result.stdout.split('\n')[0] if result.stdout else "installed"
                # Store for later use
                CMAKE_PATH = cmake_path
                return True, version
            except:
                return False, ""
        return False, ""

    # Special handling for pnpm on Windows
    if name == "pnpm" and system_name == "Windows":
        pnpm_path = find_pnpm_windows()
        if pnpm_path:
            try:
                # Use the full path directly - Windows can execute .cmd files this way
                result = subprocess.run(
                    [pnpm_path, "--version"],
                    capture_output=True,
                    text=True,
                    check=True
                )
                version = result.stdout.split('\n')[0] if result.stdout else "installed"
                # Store for later use
                PNPM_PATH = pnpm_path
                return True, version
            except:
                # If execution fails, fall through to standard check
                pass
        # Fall through to standard check if Windows-specific search failed

    # Standard check for other tools (and fallback for pnpm on Windows)
    tool_path = shutil.which(command[0])
    if tool_path:
        try:
            # Use the full path found by shutil.which for better reliability
            result = subprocess.run(
                [tool_path] + command[1:],
                capture_output=True,
                text=True,
                check=True
            )
            version = result.stdout.split('\n')[0] if result.stdout else "installed"
            # Store pnpm path if found via standard check
            if name == "pnpm":
                PNPM_PATH = tool_path
            return True, version
        except:
            return False, ""
    return False, ""

def check_vcpkg() -> Optional[str]:
    """Check vcpkg and return root path (with Windows-specific detection)."""
    system_name, _ = detect_platform()

    if system_name == "Windows":
        return find_vcpkg_windows()
    else:
        # Unix-like systems
        for env_var in ["VCPKG_ROOT", "VCPKG_INSTALLATION_ROOT"]:
            vcpkg_root = os.environ.get(env_var)
            if vcpkg_root and os.path.isdir(vcpkg_root):
                return vcpkg_root

        vcpkg_cmd = shutil.which("vcpkg")
        if vcpkg_cmd:
            return str(Path(vcpkg_cmd).parent)

    return None

def check_prerequisites(skip_app: bool):
    """Check all prerequisites with clean table output."""
    tools = [
        ("CMake", ["cmake", "--version"]),
        ("Ninja", ["ninja", "--version"]),
    ]

    if not skip_app:
        tools.append(("pnpm", ["pnpm", "--version"]))

    results = []
    all_ok = True

    for name, cmd in tools:
        ok, version = check_tool(name, cmd)
        results.append((name, ok, version))
        if not ok:
            all_ok = False

    # Check vcpkg separately
    vcpkg_root = check_vcpkg()
    if vcpkg_root:
        os.environ["VCPKG_ROOT"] = vcpkg_root
        results.append(("vcpkg", True, vcpkg_root))
    else:
        results.append(("vcpkg", False, "not found"))
        all_ok = False

    # Print results
    system_name, _ = detect_platform()
    for name, ok, info in results:
        if ok:
            log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} {name}')
            # Show version for tools, or path for vcpkg
            if info:
                # Show version for CMake, Ninja, pnpm (always)
                # Show path for vcpkg (on Windows or in verbose mode)
                if name in ["CMake", "Ninja", "pnpm"]:
                    log_dim(info)
                elif name == "vcpkg" and (VERBOSE or system_name == "Windows"):
                    log_dim(info)
        else:
            log(f'{Style.RED}{Style.CROSS}{Style.RESET} {name} {Style.GRAY}(missing){Style.RESET}')

    if not all_ok:
        print()
        if system_name == "Windows":
            print(f'  {Style.YELLOW}{Style.INFO} Windows Tips:{Style.RESET}')
            print(f'  {Style.DIM}• Run from "Developer Command Prompt for VS" to use bundled tools{Style.RESET}')
            print(f'  {Style.DIM}• Or install standalone: CMake, Ninja, vcpkg{Style.RESET}')
            print(f'  {Style.DIM}• Set VCPKG_ROOT environment variable if vcpkg is installed{Style.RESET}')
            print()
        print_error("Missing prerequisites - install them and try again")

    print()

def run_command(cmd: List[str], cwd: Optional[Path] = None, description: str = "") -> Tuple[bool, str]:
    """Run command with spinner or verbose output."""
    global PNPM_PATH
    system_name, _ = detect_platform()
    
    # Resolve pnpm path on Windows if needed
    if cmd and cmd[0] == "pnpm" and system_name == "Windows" and PNPM_PATH != "pnpm":
        cmd = [PNPM_PATH] + cmd[1:]
    
    try:
        if VERBOSE:
            log_dim(f'$ {" ".join(cmd)}')
            result = subprocess.run(cmd, cwd=cwd, check=True)
            return True, ""
        else:
            result = subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)
            return True, result.stdout + result.stderr
    except subprocess.CalledProcessError as e:
        output = ""
        if hasattr(e, 'stdout') and e.stdout:
            output += e.stdout
        if hasattr(e, 'stderr') and e.stderr:
            output += e.stderr

        print_command_error(cmd, e.returncode, output, description)
        return False, output
    except FileNotFoundError:
        print_error(f"Command not found: {cmd[0]}")
        return False, ""

def build_engine(preset: str, clean: bool, run_tests: bool, project_root: Path) -> Optional[Path]:
    """Build C++ engine."""
    engine_dir = project_root / "engine"

    if "dev" in preset:
        build_dir = engine_dir / "build"
        build_type = "Debug"
    else:
        build_dir = engine_dir / "build-release"
        build_type = "Release"

    log_dim(f'Build type: {build_type}')
    log_dim(f'Preset: {preset}')
    print()

    # Clean
    if clean and build_dir.exists():
        spinner = Spinner("Cleaning build directory")
        spinner.start()
        shutil.rmtree(build_dir)
        spinner.stop()
        print()

    # Configure
    spinner = Spinner("Configuring CMake")
    spinner.start()

    configure_cmd = [CMAKE_PATH, "--preset", preset]
    if run_tests:
        configure_cmd.append("-DVAYU_BUILD_TESTS=ON")

    success, output = run_command(configure_cmd, cwd=engine_dir, description="CMake configuration")

    if success:
        spinner.stop()
    else:
        spinner.stop(Style.CROSS, Style.RED)
        return None

    print()

    # Build
    spinner = Spinner(f"Building {build_type}")
    spinner.start()

    build_cmd = [CMAKE_PATH, "--build", "--preset", preset]
    success, output = run_command(build_cmd, cwd=engine_dir, description="Build")

    if success:
        spinner.stop()
    else:
        spinner.stop(Style.CROSS, Style.RED)
        return None

    # Verify binary
    system_name, _ = detect_platform()
    if system_name == "Windows":
        binary_name = f"{build_type}/vayu-engine.exe"
    else:
        binary_name = "vayu-engine"

    engine_binary = build_dir / binary_name

    if not engine_binary.exists():
        print_error(f"Binary not found: {engine_binary}")
        return None

    # Tests
    if run_tests:
        print()
        spinner = Spinner("Running tests")
        spinner.start()

        test_cmd = ["ctest", "--preset", preset]
        success, output = run_command(test_cmd, cwd=engine_dir, description="Unit tests")

        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return None

    return engine_binary

def run_tests_only(preset: str, project_root: Path) -> bool:
    """Run tests on existing build without rebuilding."""
    engine_dir = project_root / "engine"

    # Check if build directory exists
    if "dev" in preset:
        build_dir = engine_dir / "build"
    else:
        build_dir = engine_dir / "build-release"

    if not build_dir.exists():
        print_error(f"Build directory not found: {build_dir}\nRun a build first with: python build.py -e -t")
        return False

    # Check if tests were built
    test_binary = build_dir / "vayu_tests"
    system_name, _ = detect_platform()
    if system_name == "Windows":
        build_type = "Debug" if "dev" in preset else "Release"
        test_binary = build_dir / build_type / "vayu_tests.exe"

    if not test_binary.exists():
        print_error(f"Tests not found. Build with tests first:\npython build.py -e -t")
        return False

    log_dim(f'Build directory: {build_dir}')
    log_dim(f'Preset: {preset}')
    print()

    spinner = Spinner("Running tests")
    spinner.start()

    test_cmd = ["ctest", "--preset", preset, "--output-on-failure"]

    # Run with output visible in verbose mode
    if VERBOSE:
        spinner.stop()
        log_dim(f'$ {" ".join(test_cmd)}')
        result = subprocess.run(test_cmd, cwd=engine_dir)
        success = result.returncode == 0
    else:
        result = subprocess.run(test_cmd, cwd=engine_dir, capture_output=True, text=True)
        success = result.returncode == 0
        output = result.stdout + result.stderr

        if success:
            spinner.stop()
            # Parse test count from output
            if "tests passed" in output.lower():
                for line in output.split('\n'):
                    if "tests passed" in line.lower():
                        print(f'  {Style.GREEN}{Style.CHECK}{Style.RESET} {line.strip()}')
                        break
        else:
            spinner.stop(Style.CROSS, Style.RED)
            print()
            print(f'  {Style.RED}{Style.CROSS} Tests failed{Style.RESET}')
            print()
            # Show failed test output
            lines = output.strip().split('\n')
            for line in lines:
                if any(kw in line.lower() for kw in ['failed', 'error', 'fatal']):
                    print(f'  {Style.RED}{line}{Style.RESET}')
                elif line.strip():
                    print(f'  {Style.GRAY}{line}{Style.RESET}')

    return success

def setup_icons(project_root: Path):
    """Setup application icons."""
    spinner = Spinner("Setting up icons")
    spinner.start()

    icon_png_dir = project_root / "shared" / "icon_png"
    icon_ico_dir = project_root / "shared" / "icon_ico"
    build_dir = project_root / "app" / "build"

    build_dir.mkdir(exist_ok=True)

    # Copy icons
    png_256 = icon_png_dir / "vayu_icon_256x256.png"
    if png_256.exists():
        shutil.copy(png_256, build_dir / "icon.png")

    ico_256 = icon_ico_dir / "vayu_icon_256x256.ico"
    if ico_256.exists():
        shutil.copy(ico_256, build_dir / "icon.ico")

    png_512 = icon_png_dir / "vayu_icon_512x512.png"
    if png_512.exists():
        shutil.copy(png_512, build_dir / "icon.png")

    icon_set_dir = build_dir / "icons"
    icon_set_dir.mkdir(exist_ok=True)

    if icon_png_dir.exists():
        for png_file in icon_png_dir.glob("*.png"):
            shutil.copy(png_file, icon_set_dir)

    spinner.stop()

def build_app(dev_mode: bool, engine_binary: Optional[Path], project_root: Path) -> bool:
    """Build Electron app."""
    app_dir = project_root / "app"

    if not app_dir.exists():
        print_error(f"App directory not found: {app_dir}")
        return False

    # Install dependencies
    if not (app_dir / "node_modules").exists():
        spinner = Spinner("Installing dependencies")
        spinner.start()
        success, _ = run_command(["pnpm", "install"], cwd=app_dir, description="pnpm install")
        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return False
        print()

    # Icons
    setup_icons(project_root)
    print()

    if dev_mode:
        # Dev build
        spinner = Spinner("Compiling TypeScript")
        spinner.start()
        success, _ = run_command(["pnpm", "run", "electron:compile"], cwd=app_dir, description="TypeScript compilation")
        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return False
    else:
        # Prod build
        spinner = Spinner("Compiling TypeScript")
        spinner.start()
        success, _ = run_command(["pnpm", "run", "electron:compile"], cwd=app_dir, description="TypeScript compilation")
        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return False

        print()

        spinner = Spinner("Building React app")
        spinner.start()
        success, _ = run_command(["pnpm", "run", "build"], cwd=app_dir, description="React build")
        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return False

        print()

        # Copy engine binary
        if engine_binary and engine_binary.exists():
            spinner = Spinner("Copying engine binary")
            spinner.start()

            resources_dir = app_dir / "build" / "resources" / "bin"
            resources_dir.mkdir(parents=True, exist_ok=True)

            system_name, _ = detect_platform()
            if system_name == "Windows":
                target_name = "vayu-engine.exe"
                dll_dir = engine_binary.parent
                for dll in dll_dir.glob("*.dll"):
                    shutil.copy(dll, resources_dir)
            else:
                target_name = "vayu-engine"

            shutil.copy(engine_binary, resources_dir / target_name)
            os.chmod(resources_dir / target_name, 0o755)

            spinner.stop()
            print()

        # Package
        spinner = Spinner("Packaging application")
        spinner.start()
        success, _ = run_command(["pnpm", "run", "electron:pack"], cwd=app_dir, description="Electron packaging")
        if success:
            spinner.stop()
        else:
            spinner.stop(Style.CROSS, Style.RED)
            return False

    return True

def get_artifacts(dev_mode: bool, skip_engine: bool, skip_app: bool,
                 engine_binary: Optional[Path], project_root: Path) -> List[Tuple[str, str]]:
    """Collect build artifacts."""
    artifacts = []
    app_dir = project_root / "app"

    if not skip_engine and engine_binary and engine_binary.exists():
        try:
            rel_path = engine_binary.relative_to(Path.cwd())
        except ValueError:
            rel_path = engine_binary
        artifacts.append(("Engine", str(rel_path)))

    if not skip_app and not dev_mode:
        release_dir = app_dir / "release"
        if release_dir.exists():
            system_name, _ = detect_platform()

            if system_name == "Windows":
                for installer in release_dir.glob("*.exe"):
                    try:
                        rel_path = installer.relative_to(Path.cwd())
                    except ValueError:
                        rel_path = installer
                    artifacts.append(("Installer", str(rel_path)))

            elif system_name == "Linux":
                for appimage in release_dir.glob("*.AppImage"):
                    try:
                        rel_path = appimage.relative_to(Path.cwd())
                    except ValueError:
                        rel_path = appimage
                    artifacts.append(("AppImage", str(rel_path)))

                for deb in release_dir.glob("*.deb"):
                    try:
                        rel_path = deb.relative_to(Path.cwd())
                    except ValueError:
                        rel_path = deb
                    artifacts.append(("Debian", str(rel_path)))

            elif system_name == "macOS":
                for dmg in release_dir.glob("*.dmg"):
                    try:
                        rel_path = dmg.relative_to(Path.cwd())
                    except ValueError:
                        rel_path = dmg
                    artifacts.append(("DMG", str(rel_path)))

    return artifacts

def print_next_steps(dev_mode: bool, skip_app: bool, artifacts: List[Tuple[str, str]], project_root: Path):
    """Print next steps."""
    print(f'  {Style.BOLD}Next Steps{Style.RESET}')
    print()

    if dev_mode and not skip_app:
        app_dir = project_root / "app"
        try:
            rel_path = app_dir.relative_to(Path.cwd())
        except ValueError:
            rel_path = app_dir

        print(f'  {Style.DIM}Run the development app{Style.RESET}')
        system_name, _ = detect_platform()
        cmd_sep = ";" if system_name == "Windows" else "&&"
        print(f'  {Style.CYAN}$ cd {rel_path} {cmd_sep} pnpm run electron:dev{Style.RESET}')
    elif artifacts:
        for label, path in artifacts:
            if label == "Engine":
                print(f'  {Style.DIM}Run the engine{Style.RESET}')
                print(f'  {Style.CYAN}$ ./{path}{Style.RESET}')
            elif label in ["Installer", "AppImage", "Debian", "DMG"]:
                system_name, _ = detect_platform()
                if system_name == "Windows":
                    print(f'  {Style.DIM}Run the installer{Style.RESET}')
                    print(f'  {Style.CYAN}$ ./{path}{Style.RESET}')
                elif system_name == "Linux":
                    if label == "AppImage":
                        print(f'  {Style.DIM}Run the AppImage{Style.RESET}')
                        print(f'  {Style.CYAN}$ chmod +x {path} && ./{path}{Style.RESET}')
                    elif label == "Debian":
                        print(f'  {Style.DIM}Install the package{Style.RESET}')
                        print(f'  {Style.CYAN}$ sudo dpkg -i {path}{Style.RESET}')
                elif system_name == "macOS":
                    print(f'  {Style.DIM}Open the DMG{Style.RESET}')
                    print(f'  {Style.CYAN}$ open {path}{Style.RESET}')
            break  # Only show first artifact instruction

    print()

def parse_version(version_str: str) -> Tuple[int, int, int]:
    """Parse version string into (major, minor, patch)."""
    match = re.match(r'^(\d+)\.(\d+)\.(\d+)$', version_str.strip())
    if not match:
        print_error(f"Invalid version format: {version_str} (expected: X.Y.Z)")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))

def bump_version(bump_type: str, project_root: Path, dry_run: bool = False):
    """Bump version across all project files."""
    version_file = project_root / "VERSION"
    engine_cmake = project_root / "engine" / "CMakeLists.txt"
    engine_version_hpp = project_root / "engine" / "include" / "vayu" / "version.hpp"
    engine_vcpkg_json = project_root / "engine" / "vcpkg.json"
    app_package_json = project_root / "app" / "package.json"

    # Read current version
    if not version_file.exists():
        print_error(f"VERSION file not found: {version_file}")

    current_version = version_file.read_text().strip()
    major, minor, patch = parse_version(current_version)

    # Calculate new version
    if bump_type in ['major', 'minor', 'patch']:
        if bump_type == 'major':
            new_version = f"{major + 1}.0.0"
        elif bump_type == 'minor':
            new_version = f"{major}.{minor + 1}.0"
        else:  # patch
            new_version = f"{major}.{minor}.{patch + 1}"
    else:
        # Specific version provided
        new_version = bump_type
        # Validate it
        parse_version(new_version)

    print()
    print(f'  {Style.BOLD}Version Bump{Style.RESET}')
    print()
    print(f'  {Style.CYAN}{current_version}{Style.RESET} {Style.ARROW} {Style.GREEN}{new_version}{Style.RESET}')
    print()

    if dry_run:
        print(f'  {Style.YELLOW}{Style.INFO} Dry run - no changes will be made{Style.RESET}')
        print()
        return

    new_major, new_minor, new_patch = parse_version(new_version)

    # Update VERSION file
    log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Updating VERSION')
    version_file.write_text(new_version + '\n')

    # Update CMakeLists.txt
    log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Updating engine/CMakeLists.txt')
    cmake_content = engine_cmake.read_text()
    cmake_content = re.sub(
        r'VERSION \d+\.\d+\.\d+',
        f'VERSION {new_version}',
        cmake_content
    )
    engine_cmake.write_text(cmake_content)

    # Update version.hpp
    log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Updating engine/include/vayu/version.hpp')
    hpp_content = engine_version_hpp.read_text()
    hpp_content = re.sub(r'#define VAYU_VERSION_MAJOR \d+', f'#define VAYU_VERSION_MAJOR {new_major}', hpp_content)
    hpp_content = re.sub(r'#define VAYU_VERSION_MINOR \d+', f'#define VAYU_VERSION_MINOR {new_minor}', hpp_content)
    hpp_content = re.sub(r'#define VAYU_VERSION_PATCH \d+', f'#define VAYU_VERSION_PATCH {new_patch}', hpp_content)
    hpp_content = re.sub(r'#define VAYU_VERSION_STRING ".*"', f'#define VAYU_VERSION_STRING "{new_version}"', hpp_content)
    engine_version_hpp.write_text(hpp_content)

    # Update engine/vcpkg.json
    log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Updating engine/vcpkg.json')
    vcpkg_data = json.loads(engine_vcpkg_json.read_text())
    vcpkg_data['version'] = new_version
    engine_vcpkg_json.write_text(json.dumps(vcpkg_data, indent=2) + '\n')

    # Update app/package.json
    log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Updating app/package.json')
    package_data = json.loads(app_package_json.read_text())
    package_data['version'] = new_version
    app_package_json.write_text(json.dumps(package_data, indent='\t') + '\n')

    print()
    print(f'  {Style.GREEN}{Style.CHECK} Version bumped to {new_version}{Style.RESET}')
    print()
    print(f'  {Style.BOLD}Next Steps{Style.RESET}')
    print()
    print(f'  {Style.DIM}Review changes{Style.RESET}')
    print(f'  {Style.CYAN}$ git diff{Style.RESET}')
    print()
    system_name, _ = detect_platform()
    cmd_sep = ";" if system_name == "Windows" else "&&"
    print(f'  {Style.DIM}Commit and tag{Style.RESET}')
    print(f'  {Style.CYAN}$ git commit -am "chore: bump version to {new_version}"{Style.RESET}')
    print(f'  {Style.CYAN}$ git tag v{new_version}{Style.RESET}')
    print(f'  {Style.CYAN}$ git push {cmd_sep} git push --tags{Style.RESET}')
    print()

def main():
    global VERBOSE

    parser = argparse.ArgumentParser(
        description='Vayu build system',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f'''
{Style.BOLD}examples{Style.RESET}
  python build.py                      build everything (production)
  python build.py --dev                build everything (development)
  python build.py -e                   build engine only
  python build.py -a                   build app only
  python build.py -e -t                build engine + run tests
  python build.py --test-only          run tests without rebuilding
  python build.py -c -v                clean build with verbose output
  python build.py --bump-version patch bump patch version (0.1.1 -> 0.1.2)
  python build.py --bump-version 2.0.0 set specific version

{Style.BOLD}aliases{Style.RESET}
  -e  --engine-only    -a  --app-only       -c  --clean
  -t  --tests          -v  --verbose
        '''
    )

    parser.add_argument('--dev', action='store_true', help='development build')
    parser.add_argument('--prod', action='store_true', help='production build (default)')
    parser.add_argument('-e', '--engine-only', action='store_true', help='build engine only')
    parser.add_argument('-a', '--app-only', action='store_true', help='build app only')
    parser.add_argument('-c', '--clean', action='store_true', help='clean build')
    parser.add_argument('-t', '--tests', action='store_true', help='build and run engine tests')
    parser.add_argument('--test-only', action='store_true', help='run existing tests without rebuilding')
    parser.add_argument('--bump-version', metavar='VERSION', help='bump version (major|minor|patch|X.Y.Z)')
    parser.add_argument('--dry-run', action='store_true', help='show version changes without applying (use with --bump-version)')
    parser.add_argument('-v', '--verbose', action='store_true', help='verbose output')

    args = parser.parse_args()

    VERBOSE = args.verbose
    project_root = Path(__file__).parent.resolve()

    # Handle version bumping (exits early)
    if args.bump_version:
        print_header()
        bump_version(args.bump_version, project_root, args.dry_run)
        return

    dev_mode = args.dev or not args.prod
    skip_engine = args.app_only
    skip_app = args.engine_only

    # Handle test-only mode
    if args.test_only:
        skip_app = True  # Tests are for engine only
        if args.tests:
            print_error("Cannot use --test-only with -t (tests will run automatically)")

    if skip_engine and skip_app:
        print_error("Cannot use -e and -a together")

    system_name, preset_prefix = detect_platform()
    mode_suffix = "dev" if dev_mode else "prod"
    preset = f"{preset_prefix}-{mode_suffix}"

    total_steps = 1  # Prerequisites
    if not skip_engine:
        total_steps += 1
    if not skip_app:
        total_steps += 1

    start_time = time.time()

    # Handle test-only mode separately
    if args.test_only:
        print_header()
        print_step(1, 1, "Tests")
        print()
        if not run_tests_only(preset, project_root):
            sys.exit(1)

        elapsed = int(time.time() - start_time)
        print()
        print(f'  {Style.GREEN}{Style.CHECK} Tests complete{Style.RESET} {Style.DIM}({elapsed}s){Style.RESET}')
        print()
        return

    # Header
    print_header()

    # Build info
    components = []
    if not skip_engine:
        components.append("Engine")
    if not skip_app:
        components.append("App")

    mode_display = "Development" if dev_mode else "Production"
    print_build_info(mode_display, components, system_name, VERBOSE)

    current_step = 0

    try:

        # Prerequisites
        current_step += 1
        print_step(current_step, total_steps, "Prerequisites")
        check_prerequisites(skip_app)

        engine_binary = None

        # Build engine
        if not skip_engine:
            current_step += 1
            print_step(current_step, total_steps, "Engine")
            engine_binary = build_engine(preset, args.clean, args.tests, project_root)
            if not engine_binary:
                sys.exit(1)
        else:
            # Find existing binary
            engine_dir = project_root / "engine"
            build_dir = engine_dir / ("build" if dev_mode else "build-release")

            if system_name == "Windows":
                build_type = "Debug" if dev_mode else "Release"
                engine_binary = build_dir / build_type / "vayu-engine.exe"
            else:
                engine_binary = build_dir / "vayu-engine"

            if engine_binary.exists():
                log(f'{Style.GREEN}{Style.CHECK}{Style.RESET} Using existing engine binary')
                print()

        # Build app
        if not skip_app:
            current_step += 1
            print_step(current_step, total_steps, "Application")
            if not build_app(dev_mode, engine_binary, project_root):
                sys.exit(1)

        # Success
        elapsed = int(time.time() - start_time)
        artifacts = get_artifacts(dev_mode, skip_engine, skip_app, engine_binary, project_root)

        print_success(elapsed, artifacts)
        print_next_steps(dev_mode, skip_app, artifacts, project_root)

    except KeyboardInterrupt:
        print()
        print_error("Build interrupted")
    except Exception as e:
        print()
        if VERBOSE:
            import traceback
            traceback.print_exc()
        print_error(str(e))

if __name__ == "__main__":
    main()
