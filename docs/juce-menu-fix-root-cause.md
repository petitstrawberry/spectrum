# JUCE AudioUnit Menu Click Issue - Root Cause Analysis and Fix

## Problem
JUCE-based AudioUnit plugins display their UI correctly, but popup menus (preset dropdowns, right-click menus) don't respond to clicks.

## Root Cause Investigation

### What We Discovered
Through extensive testing (documented in `plugin-ui-menu-issue-investigation.md`), we found:

1. **The issue is NOT in `audio_unit_ui.rs`** - Copying the file to v1-last branch proved it works fine
2. **The issue IS in how Tauri's event loop interacts with NSMenu's modal tracking**
3. **Specifically: The `.build()` + `.run(closure)` pattern in `lib.rs` affects NSRunLoop behavior**

### Technical Background

#### NSRunLoop and Modal Tracking
When NSMenu opens on macOS:
1. The run loop switches to `NSEventTrackingRunLoopMode`
2. Only menu-related events are processed
3. Normal window events are paused until the menu closes

#### Tauri/winit Event Loop
- Tauri uses winit/tao for cross-platform windowing
- On macOS, this sits on top of AppKit's NSRunLoop
- The event loop must respect NSEventTrackingRunLoopMode for menus to work

#### The Conflict
- **v1-last (working)**: Uses `.run(context)` - simpler event loop integration
- **dev (broken)**: Uses `.build()` + `.run(closure)` - adds custom event handling that interferes with modal tracking

### Why JUCE Plugins Are Affected
JUCE framework creates separate NSWindow instances for popup menus. These windows:
- Are not children of the host window initially
- Need proper NSRunLoop mode integration
- Require the host window to properly participate in modal tracking

## The Fix

Instead of detecting and configuring menu windows (which was the previous approach), we now:

**Configure the plugin window to properly participate in NSRunLoop's modal tracking:**

```rust
// Allow event processing during modal tracking (NSEventTrackingRunLoopMode)
let _: () = msg_send![&*window, setWorksWhenModal: true];

// Enable the panel to become key/main for proper focus handling
let _: () = msg_send![&*window, setFloatingPanel: true];
let _: () = msg_send![&*window, setBecomesKeyOnlyIfNeeded: false];
let _: () = msg_send![&*window, setCanBecomeKeyWindow: true];
let _: () = msg_send![&*window, setCanBecomeMainWindow: true];
```

### Why This Works

1. **`setWorksWhenModal: true`**: Allows the window to process events even when another window (like a menu) is in modal tracking mode
2. **`setFloatingPanel: true`**: Properly configures NSPanel behavior for auxiliary windows
3. **`setBecomesKeyOnlyIfNeeded: false`**: Ensures the window can always become key, not just when "needed"
4. **`setCanBecomeKeyWindow/MainWindow: true`**: Explicitly enables key/main window capability, which NSMenu requires for event dispatch

These settings ensure the plugin window properly participates in AppKit's event loop during modal tracking, allowing JUCE's menu windows to receive events.

## Testing

Requires macOS hardware with JUCE-based AudioUnit plugins:
- TAL-NoiseMaker
- Valhalla FreqEcho  
- Surge XT
- Vital

Verify:
- Preset menus respond to clicks
- Right-click context menus work
- Combo boxes and dropdowns function
- No regression in other plugin types

## References

- Investigation document: `docs/plugin-ui-menu-issue-investigation.md`
- Apple NSRunLoop modes: https://developer.apple.com/documentation/foundation/runloop/run_loop_modes
- NSEventTrackingRunLoopMode: https://developer.apple.com/documentation/appkit/nseventtrackingrunloopmode
- Tauri/tao event handling: https://deepwiki.com/tauri-apps/tao/7.2-event-handling
