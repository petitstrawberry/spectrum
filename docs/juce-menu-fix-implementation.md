# JUCE AudioUnit Preset Menu Click Fix - Implementation Details

## Problem Summary

JUCE-based AudioUnit plugins display their UI correctly in Spectrum, but popup menus (preset dropdowns, right-click menus, etc.) don't respond to mouse clicks. The menus appear visually but clicking on menu items has no effect.

## Root Cause

JUCE framework creates separate `NSWindow` instances for popup menus rather than using the host's window hierarchy. When embedded in a Tauri application, these menu windows don't receive proper event handling configuration, causing clicks to be ignored during modal event tracking (NSEventTrackingRunLoopMode).

The issue is NOT in the audio_unit_ui.rs window creation code itself (proven through branch testing - see plugin-ui-menu-issue-investigation.md), but rather in how menu windows created by JUCE plugins interact with the host application's event loop.

## Solution Overview

The fix implements a multi-layered approach:

1. **Window Observation**: Monitor for new windows created by JUCE plugins
2. **Menu Detection**: Identify menu-like windows based on characteristics
3. **Event Configuration**: Configure menu windows for proper event handling
4. **Host Configuration**: Ensure the plugin window (NSPanel) can handle focus properly

## Implementation Details

### 1. Child Window Observer

Located in `src-tauri/src/audio_unit_ui.rs`

```rust
fn install_child_window_observer(window: &NSWindow, instance_id: &str)
```

This function sets up observers for window notifications:

- **NSWindowDidBecomeKeyNotification**: Fires when any window becomes the key window
- **NSWindowDidBecomeMainNotification**: Fires when any window becomes the main window

The observers are global (not window-specific) to catch all new windows, including those created by JUCE plugins.

### 2. Menu Window Detection

```rust
fn is_menu_window(window: *mut AnyObject) -> bool
```

Detects menu windows using two criteria:

1. **Class Name Check**: Window class contains "Menu" or "Popup" (e.g., NSCarbonMenuWindow)
2. **Window Level Check**: Window level equals NSPopUpMenuWindowLevel (101)

### 3. Menu Window Configuration

```rust
fn configure_menu_window(window: *mut AnyObject)
```

Configures detected menu windows with essential properties:

```objc
setWorksWhenModal: true          // Work during modal event tracking loops
setIgnoresMouseEvents: false     // Accept mouse events
setAcceptsMouseMovedEvents: true // Accept mouse move events
setHidesOnDeactivate: false      // Don't hide when app deactivates
```

These settings ensure the menu window can receive and process mouse events even during modal tracking.

### 4. Plugin Window (NSPanel) Configuration

In `open_audio_unit_ui()`, the plugin window is configured:

```objc
setFloatingPanel: true           // Proper floating window behavior
setBecomesKeyOnlyIfNeeded: false // Can always become key
setCanBecomeKeyWindow: true      // Enable key window capability
setCanBecomeMainWindow: true     // Enable main window capability
setWorksWhenModal: true          // Work during modal sessions
```

These settings ensure the plugin window can properly manage focus and doesn't interfere with child menu windows.

### 5. Observer Cleanup

```rust
fn remove_child_window_observer(instance_id: &str)
```

Properly removes notification observers when closing the plugin UI to prevent memory leaks and stale observers.

## How It Works

1. **Plugin Opens**: When a plugin UI is opened, we create an NSPanel and install window observers
2. **Menu Creation**: JUCE plugin creates a popup menu → new NSWindow instance
3. **Detection**: Our observer catches NSWindowDidBecomeKeyNotification for the menu window
4. **Verification**: Check if window is a menu (class name or window level)
5. **Configuration**: Apply proper event handling settings to the menu window
6. **User Interaction**: Menu now receives mouse events and clicks work properly

## Technical Background

### NSMenu and Modal Tracking

When NSMenu displays a popup, it:
1. Creates a new NSWindow at NSPopUpMenuWindowLevel
2. Enters NSEventTrackingRunLoopMode (modal event loop)
3. Intercepts mouse/keyboard events for the menu
4. Requires specific window properties to function in embedded contexts

### Why JUCE Plugins Fail in Tauri

- Tauri uses winit for window management, which has its own event loop
- winit's event loop doesn't automatically forward events to child windows
- JUCE expects native AppKit event handling throughout the window hierarchy
- Without proper configuration, menu windows are created but can't receive events

### Why This Fix Works

- Observers catch menu windows as they're created
- Immediate configuration ensures events work from first display
- Multiple notification types catch different creation patterns
- Panel configuration ensures no interference from parent window

## Testing Recommendations

### Test Cases

1. **Basic Menu Interaction**
   - Open JUCE plugin UI
   - Click on preset menu
   - Verify menu items are clickable
   - Verify menu closes after selection

2. **Focus Handling**
   - Open menu while plugin window is key
   - Open menu while plugin window is not key
   - Switch between plugin windows
   - Verify menus still work in all cases

3. **Multiple Menus**
   - Open multiple JUCE plugins
   - Open menus in different plugins
   - Verify no interference between plugin instances

4. **Edge Cases**
   - Right-click context menus
   - Combo box dropdowns
   - Nested menus (submenus)
   - Menu keyboard shortcuts

### Test Plugins

Recommended JUCE-based AudioUnit plugins for testing:

- **TAL-NoiseMaker** (free synth with preset menu)
- **Valhalla FreqEcho** (free effect with preset menu)
- **Surge XT** (open source, JUCE-based)
- **Vital** (free synth, extensive menu usage)

### Debugging

If menus still don't work:

1. Check console logs for "Configured menu window" messages
2. Verify window class name and level are detected
3. Use `printf` debugging in observer blocks
4. Check if NSWindowDidBecomeKeyNotification fires
5. Verify menu window has parent relationship to plugin window

## Performance Considerations

- Observers are global but filtered quickly
- Only configuration overhead when menus are actually opened
- Negligible impact on plugin audio processing
- Observers are properly cleaned up on window close

## Future Improvements

Potential enhancements:

1. **Proactive Polling**: Periodically check for new child windows
2. **Window Hierarchy Tracking**: Maintain explicit parent-child relationships
3. **JUCE-Specific Detection**: Detect JUCE framework directly and apply targeted fixes
4. **Event Loop Integration**: Deeper integration with Tauri's event loop

## Related Files

- `src-tauri/src/audio_unit_ui.rs` - Main implementation
- `docs/plugin-ui-menu-issue-investigation.md` - Investigation history
- `README_ja.md` - User-facing documentation (Japanese)

## References

- [JUCE PopupMenu Issues in Plugin Hosts](https://github.com/juce-framework/JUCE/issues/401)
- [NSWindow Child Window Documentation](https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:))
- [NSPanel Documentation](https://developer.apple.com/documentation/appkit/nspanel)
- [Modal Event Tracking on macOS](https://developer.apple.com/documentation/foundation/runloop/mode/1409321-eventtracking)
