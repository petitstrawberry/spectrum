# Spectrum

English | **[日本語](README_ja.md)**


**Spectrum** is a **Audio Mixer & Router** for macOS. Mix, route, and process audio from multiple sources to any output device with a visual graph-based interface.

> When paired with **Prism** (a virtual audio splitter), Spectrum lets you capture per-application audio and route it independently — perfect for streaming, recording, or complex monitoring setups.


## What Can Spectrum Do?

- **Visual Audio Routing**: Connect any input to any output with a node-based graph
- **Per-Application Control**: Route Discord, Spotify, game audio, etc. to different outputs (requires Prism)
- **Real-time Mixing**: Adjust levels, mute channels, and see live audio meters
- **AudioUnit Effects**: Add reverb, EQ, compression, and other AU plugins to any bus
- **Multi-Device Output**: Send audio to headphones, speakers, and recording software simultaneously


## Prerequisites

- **macOS** (10.15 or later)
- **Xcode Command Line Tools**: `xcode-select --install`


## Quick Start

### For Users

1. **Download Spectrum** (or build from source — see Development section below)

2. **Install Prism** (optional, for per-app audio routing):
   ```bash
   cd prism
   cargo install --path .
   ./build_driver.sh
   sudo ./install.sh
   # Reboot macOS
   ```

3. **Start Prism daemon** (if using Prism):
   ```bash
   prismd --daemonize
   ```

4. **Launch Spectrum** and start routing audio!


## Known Issues

### AudioUnit Plugin UI — JUCE Preset Menus Fixed

**Status**: ✅ Fixed in this branch

**Previous Issue**: AudioUnit plugins built with the JUCE framework displayed their UI correctly, but preset menus (dropdown/popup menus) didn't respond to clicks.

**Solution**: Implemented a child window observer that monitors and configures menu windows created by JUCE plugins. The fix ensures proper event handling during modal tracking by:
- Observing window notifications to detect menu windows
- Configuring menu windows with proper event handling properties
- Ensuring the plugin window (NSPanel) can handle focus properly

**Technical Details**: See `docs/juce-menu-fix-implementation.md` for complete implementation details.

**Testing**: If you encounter issues with plugin menus, please report them with:
- Plugin name and version
- macOS version
- Steps to reproduce
- Console output (look for "Configured menu window" messages)


## Development

### Repository Structure

- `src/` — Frontend (React UI)
- `src-tauri/` — Backend (Rust / Tauri)
- `docs/` — v2 architecture & improvement plans

### Setup

**Prerequisites:**
- **Node.js** and **pnpm**
- **Rust toolchain** (follows `rust-toolchain.toml`)

**Using Nix (Optional):**
```bash
nix develop
```

### Running

1. **Install Dependencies**
   ```bash
   pnpm install
   ```

2. **Run Frontend Only** (UI dev server)
   ```bash
   pnpm dev
   ```
   - Vite dev server: http://localhost:1420

3. **Run Desktop App** (Tauri)
   ```bash
   pnpm tauri dev
   ```
   > Automatically starts both UI and backend

### Building

```bash
pnpm build
pnpm tauri build
```


## Documentation

- **Documentation Index**: `docs/README.md`
- **v2 Architecture (Essential Reading)**: `docs/architecture-v2.md`
- **Improvement Plans (Performance/Lock-free, etc.)**: `docs/improvements.md`


## About Prism

**Prism** is a macOS virtual audio splitter that assigns per-application audio to a 64-channel bus. **Spectrum** acts as the mixer/router, taking those channels as input sources and routing them to output devices.

For Prism build/install/usage instructions: see `prism/README.md`


## License

Spectrum is licensed under the [MIT License](LICENSE).
