# Plugin UI Menu Issue Investigation

## Issue Summary

**Problem**: In the `dev` branch (v2), plugin preset selection menus (NSMenu/NSPopUpButton) appear visually but do not respond to clicks. The same functionality works correctly in the `compare/v1-last` branch.

**Root Cause**: The issue is NOT in `audio_unit_ui.rs`. The problem lies in other parts of the codebase, specifically the app initialization and command registration patterns in `lib.rs`.

## Investigation Timeline

### Phase 1: Initial Comparison

Compared `audio_unit_ui.rs` between branches:
- v1-last: Simple implementation with direct window creation
- dev: More sophisticated with caching system, NSPanel, window management improvements

Initial hypothesis: Changes to audio_unit_ui.rs caused the issue.

### Phase 2: Command Threading Analysis

Compared `lib.rs` between branches:

**v1-last pattern:**
```rust
// Direct synchronous command in lib.rs
#[tauri::command]
fn open_audio_unit_ui(instance_id: String) -> Result<(), String> {
    let manager = audio_unit::get_au_manager();
    let instance = manager.get_instance(&instance_id)
        .ok_or_else(|| format!("AudioUnit instance not found: {}", instance_id))?;
    let au_audio_unit = instance.get_au_audio_unit()
        .ok_or_else(|| format!("AUAudioUnit not available for instance: {}", instance_id))?;
    let name = instance.info.name.clone();
    audio_unit_ui::open_audio_unit_ui(&instance_id, au_audio_unit, &name)
}
```

**dev pattern:**
```rust
// Async command with NSOperationQueue dispatch in api/commands.rs
#[tauri::command]
pub async fn open_plugin_ui_by_instance_id(instance_id: String) -> Result<(), String> {
    // ... uses NSOperationQueue.mainQueue().addOperationWithBlock()
}
```

### Phase 3: Failed Fix Attempts

1. **dispatch_sync instead of NSOperationQueue** - Caused deadlock
2. **dispatch_async** - Still didn't work
3. **Synchronous command** - App crashed with `setWorksWhenModal` error
4. **Removed setWorksWhenModal** - Fixed crash but menus still broken
5. **Reverted to v1-last style audio_unit_ui.rs** - Still didn't work
6. **Changed lib.rs from `.build()` + `.run(closure)` to `.run()`** - Still didn't work
7. **Added child window relationship** - Still didn't work

### Phase 4: Binary Search Approach (Success)

Created new branch `debug/find-plugin-ui-issue` from `v1-last` and copied only `audio_unit_ui.rs` from `dev`.

**Result: IT WORKS!**

This proves definitively that `audio_unit_ui.rs` is NOT the cause.

## Key Differences Between Branches

### lib.rs Initialization

**v1-last:**
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            open_audio_unit_ui,
            close_audio_unit_ui,
            // ... commands defined directly in lib.rs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**dev:**
```rust
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            api::commands::open_plugin_ui_by_instance_id,
            // ... commands imported from api/commands.rs module
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // Custom event handling
    });
}
```

### Audio Initialization

**v1-last:**
```rust
// Blocking initialization
audio_unit::initialize();
```

**dev:**
```rust
// Async initialization
tauri::async_runtime::spawn_blocking(|| {
    audio_unit::initialize();
});
```

## Technical Background

### Why NSMenu Clicks Fail

macOS menu tracking (NSMenu, NSPopUpButton) uses `NSEventTrackingRunLoopMode` for modal event loops. When a menu is open, the event loop enters this special mode to handle menu interactions.

The issue appears related to how the Tauri/winit event loop interacts with these modal tracking loops. Key factors:

1. **Event loop control**: winit maintains exclusive control over the main event loop
2. **Modal tracking mode**: NSMenu requires entering `NSEventTrackingRunLoopMode`
3. **Command dispatch**: How commands are dispatched and on which thread affects event handling

### JUCE Plugin Compatibility Note

Many Audio Unit plugins use JUCE framework, which creates its own windows and runs its own message loops. This can conflict with the host application's event loop management, particularly with winit's exclusive event loop control.

## Confirmed Facts

1. **audio_unit_ui.rs is NOT the cause** - dev's version works with v1-last backend
2. **The issue is in the app initialization/command registration** in lib.rs
3. **Main thread execution is confirmed** - Debug logging showed commands run on main thread
4. **NSWindow methods work correctly** - Window creation, display, focus all work
5. **Only modal event tracking is broken** - Menus appear but don't respond

## Definitive Proof

After creating `debug/find-plugin-ui-issue` branch from v1-last and copying dev's audio_unit_ui.rs:

```
git diff dev -- src-tauri/src/audio_unit_ui.rs
(empty - files are identical)
```

**Result**: Plugin UI menus work perfectly with dev's audio_unit_ui.rs when using v1-last's backend.

## lib.rs Comparison Summary

| Aspect | v1-last (Working) | dev (Broken) |
|--------|-------------------|--------------|
| App Startup | `.run(context)` | `.build()` + `.run(closure)` |
| Command Location | Directly in lib.rs | Imported from api/commands.rs |
| Audio Init | Synchronous | `spawn_blocking` |
| Event Handler | None | Custom closure |
| Modules | audio_graph, mixer, router, audio_output, config | api, capture, device (v2 arch) |

## Critical Command Implementation Difference

### v1-last (Working)
```rust
#[tauri::command]
fn open_audio_unit_ui(instance_id: String) -> Result<(), String> {
    // Synchronous, direct call
    // Tauri already calls this on main thread
    let manager = audio_unit::get_au_manager();
    let instance = manager.get_instance(&instance_id)?;
    let au_audio_unit = instance.get_au_audio_unit()?;
    audio_unit_ui::open_audio_unit_ui(&instance_id, au_audio_unit, &name)
}
```

### dev (Broken)
```rust
#[tauri::command]
pub async fn open_plugin_ui(instance_id: String) -> Result<(), String> {
    // Async command with explicit main thread dispatch
    let (tx, rx) = std::sync::mpsc::channel();

    unsafe {
        let main_queue = msg_send![class!(NSOperationQueue), mainQueue];
        let block = RcBlock::new(move || {
            let result = audio_unit_ui::open_plugin_ui_by_instance_id(&instance_id);
            tx.send(result);
        });
        msg_send![main_queue, addOperationWithBlock: &*block];
    }

    // Wait with 5s timeout
    rx.recv_timeout(Duration::from_secs(5))?
}
```

**Key difference**: The dev version uses `async` + NSOperationQueue dispatch + mpsc channel waiting. This extra threading/dispatch layer may interfere with NSRunLoop's modal event tracking mode.

## Recommended Next Steps

1. **Isolate the exact change causing the issue** by testing each difference:
   - First test: Change dev to use `.run(context)` instead of `.build()` + `.run(closure)`
   - Second test: Move plugin UI commands back into lib.rs directly
   - Third test: Remove `spawn_blocking` for audio initialization

2. **Most likely culprit**: The custom event handler in `app.run(closure)` or the `.build()` + `.run()` pattern may interfere with NSEventTrackingRunLoopMode

3. Consider if Tauri 2.x's event loop integration differs when using `.build()` vs `.run()`

## Files Involved

- `src-tauri/src/lib.rs` - App initialization and command registration
- `src-tauri/src/audio_unit_ui.rs` - Plugin UI window management (confirmed NOT the cause)
- `src-tauri/src/api/commands.rs` - v2 API commands module
- `src-tauri/src/audio_unit.rs` - Audio Unit instance management

## Branch Reference

- `compare/v1-last` - Working reference (v1 implementation)
- `dev` - Current development branch (broken plugin menus)
- `debug/find-plugin-ui-issue` - Test branch proving audio_unit_ui.rs is not the cause
