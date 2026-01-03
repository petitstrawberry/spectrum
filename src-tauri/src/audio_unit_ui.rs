//! AudioUnit UI Window
//!
//! This module creates native Cocoa windows to display AudioUnit custom views.
//! Supports both AUv2 (CocoaUI) and AUv3 (requestViewController) plugins.
//!
//! Note: NSWindow is not thread-safe, so we store window numbers (i64) for global
//! bookkeeping, and keep any strong NSWindow references only on the main thread.
//! We can retrieve the window using [NSApp windowWithWindowNumber:].

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, MainThreadOnly, Encode, Encoding, RefEncode};
use objc2_app_kit::{NSWindow, NSWindowStyleMask, NSApplication, NSBackingStoreType};
use objc2_foundation::{NSRect, NSPoint, NSSize, NSString, MainThreadMarker};
use std::collections::HashMap;
use std::ffi::c_void;
use std::cell::RefCell;
use std::sync::{Arc, RwLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

// CoreFoundation RunLoop functions
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, returnAfterSourceHandled: bool) -> i32;
}

// kCFRunLoopDefaultMode constant
fn get_default_run_loop_mode() -> *const c_void {
    extern "C" {
        static kCFRunLoopDefaultMode: *const c_void;
    }
    unsafe { kCFRunLoopDefaultMode }
}

// AudioComponentDescription for AUv3 support
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct AudioComponentDescription {
    component_type: u32,
    component_sub_type: u32,
    component_manufacturer: u32,
    component_flags: u32,
    component_flags_mask: u32,
}

// Implement Encode for AudioComponentDescription so it can be passed via msg_send!
unsafe impl Encode for AudioComponentDescription {
    const ENCODING: Encoding = Encoding::Struct(
        "AudioComponentDescription",
        &[
            Encoding::UInt,
            Encoding::UInt,
            Encoding::UInt,
            Encoding::UInt,
            Encoding::UInt,
        ],
    );
}

unsafe impl RefEncode for AudioComponentDescription {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

// CoreFoundation extern for CFRelease
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

// Foundation extern for NSClassFromString
#[link(name = "Foundation", kind = "framework")]
extern "C" {
    fn NSClassFromString(name: *const AnyObject) -> *mut AnyObject;
}

// AudioToolbox externs for AUv3 support
#[link(name = "AudioToolbox", kind = "framework")]
extern "C" {
    fn AudioComponentInstanceGetComponent(inInstance: *mut c_void) -> *mut c_void;
    fn AudioComponentCopyName(inComponent: *mut c_void, outName: *mut *mut c_void) -> i32;
}

// Wrapper for raw pointers to make them Send + Sync
#[derive(Clone, Copy)]
struct SendSyncPtr(*mut AnyObject);
unsafe impl Send for SendSyncPtr {}
unsafe impl Sync for SendSyncPtr {}

// Store open plugin window numbers (i64 is Send + Sync)
lazy_static::lazy_static! {
    static ref PLUGIN_WINDOW_NUMBERS: RwLock<HashMap<String, isize>> = RwLock::new(HashMap::new());
    // Cache view controllers to prevent deallocation while window is open
    static ref CACHED_VIEW_CONTROLLERS: RwLock<HashMap<String, SendSyncPtr>> = RwLock::new(HashMap::new());
    // NotificationCenter observer tokens for view size changes (must be removed on close)
    static ref PLUGIN_VIEW_SIZE_OBSERVERS: RwLock<HashMap<String, Vec<SendSyncPtr>>> =
        RwLock::new(HashMap::new());
    // View controllers that must not be reused after close. We keep them retained
    // to avoid teardown timing crashes, and release them when the instance is dropped.
    static ref RETIRED_VIEW_CONTROLLERS: RwLock<HashMap<String, Vec<SendSyncPtr>>> =
        RwLock::new(HashMap::new());
}

// NSWindow is not Send/Sync; we keep a strong reference on the main thread only.
thread_local! {
    static OPEN_PLUGIN_WINDOWS: RefCell<HashMap<String, Retained<NSWindow>>> = RefCell::new(HashMap::new());
}

fn activate_app_and_focus_plugin_window(window: &NSWindow, mtm: MainThreadMarker, reason: &str) {
    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        let _: () = msg_send![&app, activateIgnoringOtherApps: true];

        // Observe app focus state to diagnose "menu opens but clicks don't register".
        let app_is_active: bool = msg_send![&app, isActive];
        let key_window: *mut AnyObject = msg_send![&app, keyWindow];

        // Pointer identity for debugging.
        let this_window_ptr: *const NSWindow = window as *const NSWindow;

        // Make the window participate during modal event loops (e.g. NSMenu tracking).
        // If the host enters a modal loop, non-modal windows can stop receiving clicks.
        let _: () = msg_send![window, setWorksWhenModal: true];
        let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];

        // Defensive: ensure the window participates in normal AppKit event routing.
        // Some plugin UIs (NSMenu / NSPopUpButton) can appear but not receive clicks
        // if the host window isn't key/main or if the window is set to ignore events.
        let _: () = msg_send![window, setIgnoresMouseEvents: false];
        let _: () = msg_send![window, setHidesOnDeactivate: false];

        // User-requested: keep plugin windows floating.
        // NOTE: NSFloatingWindowLevel is 3.
        let level: isize = 3; // NSFloatingWindowLevel
        window.setLevel(level);

        // Bring to front and make key/main.
        window.makeKeyAndOrderFront(None);
        let can_become_main: bool = msg_send![window, canBecomeMainWindow];
        if can_become_main {
            let _: () = msg_send![window, makeMainWindow];
        }
        let _: () = msg_send![window, orderFrontRegardless];

        // Best-effort: make the content view first responder.
        let content_view: *mut AnyObject = msg_send![window, contentView];
        if !content_view.is_null() {
            let _: bool = msg_send![window, makeFirstResponder: content_view];
        }

        // Log current focus state for diagnosis.
        let is_key: bool = msg_send![window, isKeyWindow];
        let is_main: bool = msg_send![window, isMainWindow];
        let is_visible: bool = msg_send![window, isVisible];
        let win_level: isize = msg_send![window, level];
        println!(
            "[AudioUnitUI] focus_window reason={} app_active={} key_window_ptr={:p} this_window_ptr={:p} key={} main={} visible={} level={}",
            reason,
            app_is_active,
            key_window,
            this_window_ptr,
            is_key,
            is_main,
            is_visible,
            win_level
        );
    }
}

fn take_cached_view_controller(instance_id: &str) -> Option<*mut AnyObject> {
    CACHED_VIEW_CONTROLLERS
        .write()
        .unwrap()
        .remove(instance_id)
        .map(|SendSyncPtr(vc)| vc)
}

fn retire_view_controller(instance_id: &str, vc: *mut AnyObject) {
    if vc.is_null() {
        return;
    }
    let mut retired = RETIRED_VIEW_CONTROLLERS.write().unwrap();
    retired
        .entry(instance_id.to_string())
        .or_insert_with(Vec::new)
        .push(SendSyncPtr(vc));
}

fn release_retired_view_controllers(instance_id: &str) {
    let retired = RETIRED_VIEW_CONTROLLERS
        .write()
        .unwrap()
        .remove(instance_id)
        .unwrap_or_default();
    for SendSyncPtr(vc) in retired {
        release_view_controller(vc);
    }
}

fn release_view_controller(vc: *mut AnyObject) {
    if vc.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![vc, release];
    }
}

fn remove_view_size_observer(instance_id: &str) {
    let tokens = PLUGIN_VIEW_SIZE_OBSERVERS.write().unwrap().remove(instance_id);
    let Some(tokens) = tokens else {
        return;
    };

    unsafe {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        for SendSyncPtr(token) in tokens {
            let _: () = msg_send![center, removeObserver: token];
        }
    }
}

fn sync_window_content_size_to_view(window: &NSWindow, view: *mut AnyObject) {
    if view.is_null() {
        return;
    }

    unsafe {
        // Compute a best-effort preferred size.
        let frame: NSRect = msg_send![view, frame];
        let preferred: NSSize = msg_send![view, fittingSize];

        let mut width = if preferred.width > 10.0 {
            preferred.width
        } else if frame.size.width > 10.0 {
            frame.size.width
        } else {
            600.0
        };

        let mut height = if preferred.height > 10.0 {
            preferred.height
        } else if frame.size.height > 10.0 {
            frame.size.height
        } else {
            400.0
        };

        // Clamp to reasonable sizes.
        width = width.max(200.0).min(2000.0);
        height = height.max(100.0).min(1500.0);

        let content_view: *mut AnyObject = msg_send![window, contentView];
        if !content_view.is_null() {
            let cv_frame: NSRect = msg_send![content_view, frame];
            // Avoid re-entrant resize loops for tiny deltas.
            if (cv_frame.size.width - width).abs() < 0.5 && (cv_frame.size.height - height).abs() < 0.5 {
                return;
            }
        }

        let _: () = msg_send![window, setContentSize: NSSize::new(width, height)];
    }
}

fn set_window_fixed_content_size(window: &NSWindow, w: f64, h: f64) {
    unsafe {
        let size = NSSize::new(w, h);
        let _: () = msg_send![window, setContentMinSize: size];
        let _: () = msg_send![window, setContentMaxSize: size];
    }
}

fn clear_window_fixed_content_size(window: &NSWindow) {
    // Best-effort reset so a previously-fixed window can become resizable.
    // AppKit will still enforce its own constraints.
    unsafe {
        let _: () = msg_send![window, setContentMinSize: NSSize::new(200.0, 100.0)];
        let _: () = msg_send![window, setContentMaxSize: NSSize::new(10000.0, 10000.0)];
    }
}

fn sync_fixed_window_to_view(window: &NSWindow, instance_id: &str, view: *mut AnyObject) {
    if view.is_null() {
        return;
    }

    unsafe {
        // Prefer VC preferredContentSize (AUv3 often updates this), then intrinsic, then fitting.
        let mut width = 0.0;
        let mut height = 0.0;

        if let Some(SendSyncPtr(vc)) = CACHED_VIEW_CONTROLLERS.read().unwrap().get(instance_id).copied() {
            if !vc.is_null() {
                let preferred: NSSize = msg_send![vc, preferredContentSize];
                if preferred.width > 10.0 && preferred.height > 10.0 {
                    width = preferred.width;
                    height = preferred.height;
                }
            }
        }

        if width <= 10.0 || height <= 10.0 {
            if let Some((iw, ih)) = view_intrinsic_size(view) {
                width = iw;
                height = ih;
            }
        }

        if width <= 10.0 || height <= 10.0 {
            let fitting: NSSize = msg_send![view, fittingSize];
            if fitting.width > 10.0 && fitting.height > 10.0 {
                width = fitting.width;
                height = fitting.height;
            }
        }

        if width <= 10.0 || height <= 10.0 {
            let frame: NSRect = msg_send![view, frame];
            if frame.size.width > 10.0 && frame.size.height > 10.0 {
                width = frame.size.width;
                height = frame.size.height;
            }
        }

        if width <= 10.0 || height <= 10.0 {
            // Last resort: keep current window content size.
            let content_view: *mut AnyObject = msg_send![window, contentView];
            if !content_view.is_null() {
                let cv_frame: NSRect = msg_send![content_view, frame];
                width = cv_frame.size.width;
                height = cv_frame.size.height;
            }
        }

        if width <= 10.0 {
            width = 600.0;
        }
        if height <= 10.0 {
            height = 400.0;
        }

        width = width.max(200.0).min(2000.0);
        height = height.max(100.0).min(1500.0);

        // Avoid re-entrant resize loops for tiny deltas.
        let content_view: *mut AnyObject = msg_send![window, contentView];
        if !content_view.is_null() {
            let cv_frame: NSRect = msg_send![content_view, frame];
            if (cv_frame.size.width - width).abs() < 0.5 && (cv_frame.size.height - height).abs() < 0.5 {
                // Still enforce non-resizable + fixed constraints.
                set_window_resizable(window, false);
                set_window_fixed_content_size(window, cv_frame.size.width, cv_frame.size.height);
                return;
            }
        }

        let _: () = msg_send![window, setContentSize: NSSize::new(width, height)];
        set_window_resizable(window, false);
        set_window_fixed_content_size(window, width, height);
    }
}

fn view_intrinsic_size(view: *mut AnyObject) -> Option<(f64, f64)> {
    if view.is_null() {
        return None;
    }

    unsafe {
        // NSViewNoIntrinsicMetric is typically -1.
        let intrinsic: NSSize = msg_send![view, intrinsicContentSize];
        let w = intrinsic.width;
        let h = intrinsic.height;

        if w.is_finite() && h.is_finite() && w > 10.0 && h > 10.0 {
            Some((w, h))
        } else {
            None
        }
    }
}

fn view_is_resizable(view: *mut AnyObject) -> bool {
    if view.is_null() {
        return false;
    }

    unsafe {
        // Quick heuristic only; final decision may be calibrated.
        // Prefer treating views with real intrinsic size as fixed.
        if view_intrinsic_size(view).is_some() {
            return false;
        }

        let mask: u64 = msg_send![view, autoresizingMask];
        // NSViewWidthSizable = 2, NSViewHeightSizable = 16
        let mask_resizable = (mask & (2u64 | 16u64)) == (2u64 | 16u64);
        if mask_resizable {
            return true;
        }

        // Unknown: we'll calibrate.
        true
    }
}

fn set_window_resizable(window: &NSWindow, resizable: bool) {
    unsafe {
        let current_style: u64 = msg_send![window, styleMask];
        let resizable_flag: u64 = 8u64; // NSWindowStyleMaskResizable
        let new_style = if resizable {
            current_style | resizable_flag
        } else {
            current_style & !resizable_flag
        };
        let _: () = msg_send![window, setStyleMask: new_style];
    }
}

fn install_view_size_observer(instance_id: &str, window_number: isize, view: *mut AnyObject) {
    if view.is_null() {
        return;
    }

    // Remove any stale observer (best-effort) before installing a new one.
    remove_view_size_observer(instance_id);

    unsafe {
        // Ensure the view posts frame change notifications.
        let _: () = msg_send![view, setPostsFrameChangedNotifications: true];
        let _: () = msg_send![view, setPostsBoundsChangedNotifications: true];

        let name_frame = NSString::from_str("NSViewFrameDidChangeNotification");
        let name_bounds = NSString::from_str("NSViewBoundsDidChangeNotification");
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

        let instance = instance_id.to_string();
        let block = RcBlock::new(move |_note: *mut AnyObject| {
            // Notifications should arrive on the main queue, but we defensively check.
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };

            // If the window is gone, drop the observer.
            let Some(window) = get_window_by_number(window_number, mtm) else {
                remove_view_size_observer(&instance);
                return;
            };

            // Always follow plugin UI size; user-resize is disabled.
            sync_fixed_window_to_view(&window, &instance, view);
        });

        let token_frame: *mut AnyObject = msg_send![
            center,
            addObserverForName: &*name_frame,
            object: view,
            queue: main_queue,
            usingBlock: &*block
        ];

        let token_bounds: *mut AnyObject = msg_send![
            center,
            addObserverForName: &*name_bounds,
            object: view,
            queue: main_queue,
            usingBlock: &*block
        ];

        let mut tokens: Vec<SendSyncPtr> = Vec::new();
        if !token_frame.is_null() {
            tokens.push(SendSyncPtr(token_frame));
        }
        if !token_bounds.is_null() {
            tokens.push(SendSyncPtr(token_bounds));
        }

        if !tokens.is_empty() {
            PLUGIN_VIEW_SIZE_OBSERVERS
                .write()
                .unwrap()
                .insert(instance_id.to_string(), tokens);
        }
    }
}

fn calibrate_view_resizability(window: &NSWindow, container_view: *mut AnyObject, view: *mut AnyObject) -> bool {
    if view.is_null() {
        return false;
    }

    unsafe {
        let frame0: NSRect = msg_send![view, frame];
        let w0 = frame0.size.width;
        let h0 = frame0.size.height;

        // If view has an intrinsic size, treat as fixed.
        if view_intrinsic_size(view).is_some() {
            return false;
        }

        // Try a small content resize and see if the view follows.
        let target_w = (w0 + 120.0).max(200.0).min(2000.0);
        let target_h = (h0 + 120.0).max(100.0).min(1500.0);
        let _: () = msg_send![window, setContentSize: NSSize::new(target_w, target_h)];
        if !container_view.is_null() {
            let _: () = msg_send![container_view, layoutSubtreeIfNeeded];
        }

        let frame1: NSRect = msg_send![view, frame];
        let w1 = frame1.size.width;
        let h1 = frame1.size.height;

        // Restore back near original so we don't "inflate" fixed UIs.
        let restore_w = w0.max(200.0).min(2000.0);
        let restore_h = h0.max(100.0).min(1500.0);
        let _: () = msg_send![window, setContentSize: NSSize::new(restore_w, restore_h)];
        if !container_view.is_null() {
            let _: () = msg_send![container_view, layoutSubtreeIfNeeded];
        }

        // If the view grew significantly, it's window-resizable.
        (w1 - w0).abs() > 20.0 || (h1 - h0).abs() > 20.0
    }
}

fn defer_release_view_controller(instance_id: &str, vc: *mut AnyObject) {
    if vc.is_null() {
        return;
    }

    // Defer the release to the next main-queue runloop turn.
    // Some AU UIs (e.g. CoreAudioAUUI) are sensitive to teardown timing.
    let instance_id = instance_id.to_string();
    unsafe {
        let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
        let block = RcBlock::new(move || {
            println!("[AudioUnit] Releasing cached view controller for {}", instance_id);
            release_view_controller(vc);
        });
        let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
    }
}

/// Open a native window for an AudioUnit plugin's custom view
///
/// This function:
/// 1. Uses the existing AUAudioUnit instance to get the view controller
/// 2. Creates an NSWindow
/// 3. Embeds the AudioUnit's custom view in the window
pub fn open_audio_unit_ui(
    instance_id: &str,
    au_audio_unit: *mut AnyObject,
    plugin_name: &str,
) -> Result<(), String> {
    // Must run on main thread for UI operations
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return Err("Must be called from main thread".to_string()),
    };

    // Check if window is already open
    // 1) まず read ロックで現在のウィンドウ番号だけ読み取り、すぐにロックを解放する
    // 2) 既存ウィンドウが存在しない場合だけ write ロックを取ってマップを更新する
    let existing_window_number = {
        let map = PLUGIN_WINDOW_NUMBERS.read().unwrap();
        map.get(instance_id).copied()
    };

    if let Some(window_number) = existing_window_number {
        // Try to bring existing window to front
        if let Some(window) = get_window_by_number(window_number, mtm) {
            activate_app_and_focus_plugin_window(&window, mtm, "reuse");
            return Ok(());
        } else {
            // Window was closed externally, remove from tracking
            let mut map = PLUGIN_WINDOW_NUMBERS.write().unwrap();
            map.remove(instance_id);
            drop(map);

            OPEN_PLUGIN_WINDOWS.with(|windows| {
                windows.borrow_mut().remove(instance_id);
            });

            // Clean up any observer we installed for the previous window.
            remove_view_size_observer(instance_id);

            // Some plugins crash if we reuse the same view controller after the window closes.
            // Force a fresh requestViewController on next open.
            if let Some(vc) = take_cached_view_controller(instance_id) {
                // Don't release here; some plugins crash during teardown.
                // We'll release when the plugin instance is dropped.
                retire_view_controller(instance_id, vc);
            }
        }
    }

    // Get AudioUnit's view using existing AUAudioUnit instance
    let view = get_audio_unit_view(instance_id, au_audio_unit)?;

    // Determine window size based on the view's size
    let (window_width, window_height) = if let Some(au_view) = view {
        unsafe {
            let mut width = 0.0;
            let mut height = 0.0;

            if let Some(SendSyncPtr(vc)) = CACHED_VIEW_CONTROLLERS.read().unwrap().get(instance_id).copied() {
                if !vc.is_null() {
                    let preferred: NSSize = msg_send![vc, preferredContentSize];
                    if preferred.width > 10.0 && preferred.height > 10.0 {
                        width = preferred.width;
                        height = preferred.height;
                    }
                }
            }

            if width <= 10.0 || height <= 10.0 {
                if let Some((iw, ih)) = view_intrinsic_size(au_view) {
                    width = iw;
                    height = ih;
                }
            }

            if width <= 10.0 || height <= 10.0 {
                let fitting: NSSize = msg_send![au_view, fittingSize];
                if fitting.width > 10.0 && fitting.height > 10.0 {
                    width = fitting.width;
                    height = fitting.height;
                }
            }

            if width <= 10.0 || height <= 10.0 {
                let frame: NSRect = msg_send![au_view, frame];
                if frame.size.width > 10.0 && frame.size.height > 10.0 {
                    width = frame.size.width;
                    height = frame.size.height;
                }
            }

            if width <= 10.0 {
                width = 600.0;
            }
            if height <= 10.0 {
                height = 400.0;
            }

            // Clamp to reasonable sizes (min 200x100, max 2000x1500)
            (width.max(200.0).min(2000.0), height.max(100.0).min(1500.0))
        }
    } else {
        (600.0, 400.0) // Default size for placeholder
    };

    // Create window with the determined size
    let content_rect = NSRect::new(
        NSPoint::new(100.0, 100.0),
        NSSize::new(window_width, window_height),
    );

    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable;

    let window = unsafe {
        // Use NSPanel instead of NSWindow. NSPanel is better suited for floating/utility windows
        // and handles menu interactions/activation better when the app is active.
        let panel_class = class!(NSPanel);
        let panel_alloc: *mut AnyObject = msg_send![panel_class, alloc];
        let window_ptr: *mut AnyObject = msg_send![panel_alloc,
            initWithContentRect: content_rect
            styleMask: style
            backing: NSBackingStoreType(2) // NSBackingStoreBuffered
            defer: false
        ];
        Retained::from_raw(window_ptr as *mut NSWindow).expect("Failed to create NSPanel")
    };

    unsafe {
        // Ensure our app is active so plugin UI menus and controls receive clicks reliably.
        // Some AU views (and their NSPopUpButton/NSMenu) can behave oddly if the host app
        // isn't the active application at the time the window is shown.
        let app = NSApplication::sharedApplication(mtm);
        let _: () = msg_send![&app, activateIgnoringOtherApps: true];

        // NOTE:
        // We keep an explicit strong reference to this window in OPEN_PLUGIN_WINDOWS.
        // If we also set releasedWhenClosed = true, calling `close()` can release the
        // window while we still own a retain, leading to over-release when our Retained
        // is dropped.
        let _: () = msg_send![&*window, setReleasedWhenClosed: false];

        // =============================
        // 【重要修正 2】透過計算の無効化
        // =============================
        let _: () = msg_send![&*window, setOpaque: true];
        let _: () = msg_send![&*window, setHasShadow: true];
        let bg_color_class = class!(NSColor);
        let bg_color: *mut AnyObject = msg_send![bg_color_class, windowBackgroundColor];
        let _: () = msg_send![&*window, setBackgroundColor: bg_color];

        // タイトル設定
        let title = NSString::from_str(&format!("{} - Plugin", plugin_name));
        window.setTitle(&title);

        // ウィンドウを中央に表示
        window.center();

        // User-requested: keep plugin windows floating (always-on-top).
        let level: isize = 3; // NSFloatingWindowLevel
        window.setLevel(level);

        // =============================
        // JUCE Menu Fix: Root Cause Solution
        // =============================
        // The issue: Tauri's .build() + .run(closure) pattern affects how NSRunLoop
        // processes events in NSEventTrackingRunLoopMode (used by NSMenu for modal tracking).
        // 
        // Solution: Explicitly configure the plugin window to properly participate in
        // the run loop's modal tracking, ensuring menu windows can receive events.
        //
        // Key settings:
        // 1. worksWhenModal: true - Allow event processing during modal tracking
        // 2. Share event dispatch with NSApplication's run loop
        // 3. Ensure the window can become key/main for proper focus handling
        
        // Configure the panel for proper modal tracking integration
        let _: () = msg_send![&*window, setWorksWhenModal: true];
        let _: () = msg_send![&*window, setIgnoresMouseEvents: false];
        let _: () = msg_send![&*window, setHidesOnDeactivate: false];
        let _: () = msg_send![&*window, setAcceptsMouseMovedEvents: true];
        
        // Enable the panel to participate in AppKit's event loop properly
        // These settings ensure the window can become key/main, which is critical
        // for menu event handling in JUCE plugins
        let _: () = msg_send![&*window, setFloatingPanel: true];
        let _: () = msg_send![&*window, setBecomesKeyOnlyIfNeeded: false];
        
        // Explicitly mark the window as capable of being key/main
        // This is crucial for NSMenu event dispatch
        let _: () = msg_send![&*window, setCanBecomeKeyWindow: true];
        let _: () = msg_send![&*window, setCanBecomeMainWindow: true];

        // Always disable user resizing; window follows plugin view size.
        set_window_resizable(&window, false);
        set_window_fixed_content_size(&window, window_width, window_height);

        // Note: Don't show the window yet; we calibrate sizing first.

        // =============================
        // 【重要修正 3 & 4】GPU描画対応とAuto Layout
        // =============================
        if let Some(au_view) = view {
            // コンテナ(ContentView)を取得してGPUレイヤーを有効化
            let container_view: *mut AnyObject = msg_send![&*window, contentView];
            let _: () = msg_send![container_view, setWantsLayer: true];

            // プラグインViewもGPUレイヤーを有効化
            let _: () = msg_send![au_view, setWantsLayer: true];

            // Auto Layout用に古いリサイズ設定をOFF
            let _: () = msg_send![au_view, setTranslatesAutoresizingMaskIntoConstraints: false];

            // コンテナに追加（setContentViewで上書きしない！）
            let _: () = msg_send![container_view, addSubview: au_view];

            // --- 制約(Anchor)で上下左右を貼り付け ---
            // Debug logging for diagnosis (e.g. ProQ4)
            let mask_dbg: u64 = msg_send![au_view, autoresizingMask];
            let intrinsic_dbg: NSSize = msg_send![au_view, intrinsicContentSize];
            let fit_dbg: NSSize = msg_send![au_view, fittingSize];
            let frame_dbg: NSRect = msg_send![au_view, frame];
            println!(
                "[AudioUnitUI] {} resizable={} mask=0x{:x} intrinsic=({:.1},{:.1}) fitting=({:.1},{:.1}) frame=({:.1},{:.1})",
                instance_id,
                false,
                mask_dbg,
                intrinsic_dbg.width,
                intrinsic_dbg.height,
                fit_dbg.width,
                fit_dbg.height,
                frame_dbg.size.width,
                frame_dbg.size.height
            );

            let leading_anchor: *mut AnyObject = msg_send![au_view, leadingAnchor];
            let trailing_anchor: *mut AnyObject = msg_send![au_view, trailingAnchor];
            let top_anchor: *mut AnyObject = msg_send![au_view, topAnchor];
            let bottom_anchor: *mut AnyObject = msg_send![au_view, bottomAnchor];

            let c_leading: *mut AnyObject = msg_send![container_view, leadingAnchor];
            let c_trailing: *mut AnyObject = msg_send![container_view, trailingAnchor];
            let c_top: *mut AnyObject = msg_send![container_view, topAnchor];
            let c_bottom: *mut AnyObject = msg_send![container_view, bottomAnchor];

            // 左上はガチガチに固定、右下は同様に貼るが
            // プラグインの内部抵抗力は is_resizable によって変える
            let c1: *mut AnyObject = msg_send![leading_anchor, constraintEqualToAnchor: c_leading];
            let _: () = msg_send![c1, setActive: true];

            let c2: *mut AnyObject = msg_send![trailing_anchor, constraintEqualToAnchor: c_trailing];
            let _: () = msg_send![c2, setActive: true];

            let c3: *mut AnyObject = msg_send![top_anchor, constraintEqualToAnchor: c_top];
            let _: () = msg_send![c3, setActive: true];

            let c4: *mut AnyObject = msg_send![bottom_anchor, constraintEqualToAnchor: c_bottom];
            let _: () = msg_send![c4, setActive: true];

            // Always use strong resistance; window is fixed to plugin size.
            let priority: f32 = 1000.0;
            let orient_h: isize = 0; // Horizontal
            let orient_v: isize = 1; // Vertical

            let _: () = msg_send![au_view, setContentHuggingPriority: priority, forOrientation: orient_h];
            let _: () = msg_send![au_view, setContentHuggingPriority: priority, forOrientation: orient_v];

            let _: () = msg_send![au_view, setContentCompressionResistancePriority: priority, forOrientation: orient_h];
            let _: () = msg_send![au_view, setContentCompressionResistancePriority: priority, forOrientation: orient_v];

            // Layer設定の再確保
            let _: () = msg_send![au_view, setWantsLayer: true];

            // Best-effort initial layout after constraints.
            let _: () = msg_send![container_view, layoutSubtreeIfNeeded];

            // Ensure responder chain starts at the plugin view.
            let _: bool = msg_send![&*window, makeFirstResponder: au_view];

            // Lock window to plugin preferred size and keep following it.
            sync_fixed_window_to_view(&window, instance_id, au_view);
            install_view_size_observer(instance_id, window.windowNumber(), au_view);

            // Now show the window after setup.
            activate_app_and_focus_plugin_window(&window, mtm, "open_with_view");
        } else {
            // カスタムUIがない場合はプレースホルダー
            let label_text = format!("No custom UI available for {}", plugin_name);
            create_placeholder_view(&window, &label_text, mtm);

            // Keep placeholder non-resizable too.
            set_window_resizable(&window, false);
            set_window_fixed_content_size(&window, window_width, window_height);

            // Show window (placeholder)
            activate_app_and_focus_plugin_window(&window, mtm, "open_placeholder");
        }
    }

    // Store window number (not the window itself, as it's not Sync)
    let window_number = window.windowNumber();
    PLUGIN_WINDOW_NUMBERS.write().unwrap().insert(instance_id.to_string(), window_number);

    // Keep a strong reference to the window while it's open (main-thread only).
    // Dropping the only strong reference here can lead to later crashes during AppKit teardown.
    OPEN_PLUGIN_WINDOWS.with(|windows| {
        let window_ptr = (&*window as *const NSWindow) as *mut NSWindow;
        let retained = unsafe { Retained::retain(window_ptr) }
            .expect("NSWindow retain should succeed");
        windows.borrow_mut().insert(instance_id.to_string(), retained);
    });

    Ok(())
}

/// Close an AudioUnit UI window
pub fn close_audio_unit_ui(instance_id: &str) {
    // Remove size observer first (best-effort)
    remove_view_size_observer(instance_id);

    let window_number = match PLUGIN_WINDOW_NUMBERS.write().unwrap().remove(instance_id) {
        Some(n) => n,
        None => return,
    };

    // Must be on main thread
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return,
    };

    // Prefer our owned reference if present
    let owned_window = OPEN_PLUGIN_WINDOWS.with(|windows| windows.borrow_mut().remove(instance_id));

    if let Some(window) = owned_window.or_else(|| get_window_by_number(window_number, mtm)) {
        window.orderOut(None);
        window.close();
    }

    // We only cache view controllers to keep them alive while the window is open.
    // Reusing cached controllers across close/reopen can crash (e.g. CoreAudioAUUI).
    if let Some(vc) = take_cached_view_controller(instance_id) {
        // Don't release during close; retire for later cleanup.
        retire_view_controller(instance_id, vc);
    }
}

/// Get a window by its window number
fn get_window_by_number(window_number: isize, mtm: MainThreadMarker) -> Option<Retained<NSWindow>> {
    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        let window: *mut NSWindow = msg_send![&app, windowWithWindowNumber: window_number];
        if window.is_null() {
            None
        } else {
            // Create a retained reference
            Some(Retained::retain(window).unwrap())
        }
    }
}

/// Get the AudioUnit's custom view using existing AUAudioUnit instance
/// Uses AUv3 requestViewController - reuses the same AUAudioUnit instance
fn get_audio_unit_view(instance_id: &str, au_audio_unit: *mut AnyObject) -> Result<Option<*mut AnyObject>, String> {
    if au_audio_unit.is_null() {
        eprintln!("AUAudioUnit handle is null");
        return Err("AUAudioUnit handle is null".to_string());
    }

    println!("Getting AudioUnit view for AUAudioUnit: {:?}, instance: {}", au_audio_unit, instance_id);

    // Check if we already have a cached view controller for this instance
    if let Some(SendSyncPtr(vc)) = CACHED_VIEW_CONTROLLERS.read().unwrap().get(instance_id).copied() {
        if !vc.is_null() {
            println!("Using cached view controller for {}", instance_id);
            unsafe {
                let view: *mut AnyObject = msg_send![vc, view];
                if !view.is_null() {
                    return Ok(Some(view));
                }
            }
        }
    }

    // If we previously closed a window, we may have retired the old view controller.
    // Before requesting a new one, release any retired controllers to avoid having
    // multiple AU view controllers alive at once (some plugins crash on reopen otherwise).
    release_retired_view_controllers(instance_id);

    // Request view controller from existing AUAudioUnit instance
    for attempt in 1..=3 {
        println!("AUv3 view attempt {}/3", attempt);
        if let Some((view, view_controller)) = request_view_controller(au_audio_unit) {
            println!("Successfully obtained AUv3 view on attempt {}", attempt);
            // Cache the view controller to keep it alive
            CACHED_VIEW_CONTROLLERS.write().unwrap().insert(instance_id.to_string(), SendSyncPtr(view_controller));
            return Ok(Some(view));
        }
        // Brief pause before retry
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    println!("Failed to get AUv3 view after 3 attempts");
    Ok(None)
}

/// Request view controller from existing AUAudioUnit instance
/// Returns (view, view_controller) tuple for caching
fn request_view_controller(au_audio_unit: *mut AnyObject) -> Option<(*mut AnyObject, *mut AnyObject)> {
    unsafe {
        println!("Requesting view controller from AUAudioUnit: {:?}", au_audio_unit);

        let view_result: Arc<Mutex<Option<*mut AnyObject>>> = Arc::new(Mutex::new(None));
        let view_result_clone = Arc::clone(&view_result);
        let view_done = Arc::new(AtomicBool::new(false));
        let view_done_clone = Arc::clone(&view_done);

        let view_block = RcBlock::new(move |view_controller: *mut AnyObject| {
            if !view_controller.is_null() {
                // Retain the view controller to prevent deallocation
                let _: () = msg_send![view_controller, retain];
                *view_result_clone.lock().unwrap() = Some(view_controller);
            }

            view_done_clone.store(true, Ordering::SeqCst);
        });

        let _: () = msg_send![au_audio_unit, requestViewControllerWithCompletionHandler: &*view_block];

        // Run the RunLoop to allow completion handler to be called
        let start_time = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(10);
        let mode = get_default_run_loop_mode();

        while !view_done.load(Ordering::SeqCst) {
            if start_time.elapsed() > timeout {
                println!("Timed out waiting for view controller");
                return None;
            }
            CFRunLoopRunInMode(mode, 0.01, false);
        }

        let view_controller = view_result.lock().unwrap().take();

        if view_controller.is_none() {
            println!("No view controller available for this AUv3 plugin");
            return None;
        }

        let view_controller = view_controller.unwrap();
        println!("Got AUv3 view controller: {:?}", view_controller);

        // Get the view from the view controller
        let _: () = msg_send![view_controller, loadViewIfNeeded];
        let view: *mut AnyObject = msg_send![view_controller, view];

        if view.is_null() {
            println!("View controller has no view");
            return None;
        }

        println!("Successfully obtained AUv3 view: {:?}", view);
        Some((view, view_controller))
    }
}

/// Try to get AUv2 CocoaUI view
fn try_get_auv2_view(audio_unit: *mut c_void) -> Option<*mut AnyObject> {
    const K_AUDIO_UNIT_PROPERTY_COCOA_UI: u32 = 4013;
    const K_AUDIO_UNIT_SCOPE_GLOBAL: u32 = 0;

    #[repr(C)]
    struct AudioUnitCocoaViewInfo {
        bundle_location: *mut c_void,
        cocoa_au_view_class: [*mut c_void; 1],
    }

    extern "C" {
        fn AudioUnitGetPropertyInfo(
            unit: *mut c_void,
            prop_id: u32,
            scope: u32,
            element: u32,
            out_size: *mut u32,
            out_writable: *mut bool,
        ) -> i32;

        fn AudioUnitGetProperty(
            unit: *mut c_void,
            prop_id: u32,
            scope: u32,
            element: u32,
            out_data: *mut c_void,
            io_size: *mut u32,
        ) -> i32;
    }

    unsafe {
        let mut size: u32 = 0;
        let mut writable = false;

        let status = AudioUnitGetPropertyInfo(
            audio_unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &mut size,
            &mut writable,
        );

        println!("AUv2 CocoaUI property info: status={}, size={}", status, size);

        if status != 0 {
            return None;
        }

        let mut view_info = AudioUnitCocoaViewInfo {
            bundle_location: std::ptr::null_mut(),
            cocoa_au_view_class: [std::ptr::null_mut()],
        };

        let status = AudioUnitGetProperty(
            audio_unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            K_AUDIO_UNIT_SCOPE_GLOBAL,
            0,
            &mut view_info as *mut _ as *mut c_void,
            &mut size,
        );

        if status != 0 || view_info.bundle_location.is_null() {
            return None;
        }

        let bundle_class = class!(NSBundle);
        let bundle: *mut AnyObject = msg_send![bundle_class, bundleWithURL: view_info.bundle_location];

        if bundle.is_null() {
            CFRelease(view_info.bundle_location);
            return None;
        }

        let loaded: bool = msg_send![bundle, load];
        if !loaded {
            CFRelease(view_info.bundle_location);
            return None;
        }

        let class_name = view_info.cocoa_au_view_class[0];
        if class_name.is_null() {
            CFRelease(view_info.bundle_location);
            return None;
        }

        let ns_class_name = class_name as *const AnyObject;
        let view_factory_class = NSClassFromString(ns_class_name);

        if view_factory_class.is_null() {
            CFRelease(view_info.bundle_location);
            CFRelease(class_name);
            return None;
        }

        let factory: *mut AnyObject = msg_send![view_factory_class, alloc];
        let factory: *mut AnyObject = msg_send![factory, init];

        if factory.is_null() {
            CFRelease(view_info.bundle_location);
            CFRelease(class_name);
            return None;
        }

        let preferred_size = NSSize::new(600.0, 400.0);
        let view: *mut AnyObject = msg_send![factory, uiViewForAudioUnit: audio_unit withSize: preferred_size];

        CFRelease(view_info.bundle_location);
        CFRelease(class_name);
        let _: () = msg_send![factory, release];

        if view.is_null() {
            return None;
        }

        Some(view)
    }
}

/// Try to get AUGenericView (fallback for plugins without custom UI)
fn try_get_generic_view(audio_unit: *mut c_void) -> Option<*mut AnyObject> {
    unsafe {
        // AUGenericView is in CoreAudioKit.framework (not AudioUnit.framework)
        // [[AUGenericView alloc] initWithAudioUnit:audioUnit]

        // Load CoreAudioKit framework
        let cak_framework_path = NSString::from_str("/System/Library/Frameworks/CoreAudioKit.framework");
        let bundle_class = class!(NSBundle);
        let cak_bundle: *mut AnyObject = msg_send![bundle_class, bundleWithPath: &*cak_framework_path];
        if !cak_bundle.is_null() {
            let loaded: bool = msg_send![cak_bundle, load];
            println!("CoreAudioKit framework load: {}", loaded);
        } else {
            println!("CoreAudioKit framework bundle not found");
        }

        // Get AUGenericView class using objc_getClass
        let class_name = std::ffi::CString::new("AUGenericView").unwrap();

        extern "C" {
            fn objc_getClass(name: *const std::ffi::c_char) -> *mut AnyObject;
        }

        let au_class = objc_getClass(class_name.as_ptr());

        println!("AUGenericView class lookup: {:?}", au_class);

        if au_class.is_null() {
            println!("AUGenericView class not found in CoreAudioKit");
            return None;
        }

        // Create generic view: [[AUGenericView alloc] initWithAudioUnit:audioUnit]
        let generic_view: *mut AnyObject = msg_send![au_class, alloc];
        if generic_view.is_null() {
            println!("Failed to alloc AUGenericView");
            return None;
        }

        let generic_view: *mut AnyObject = msg_send![generic_view, initWithAudioUnit: audio_unit];

        if generic_view.is_null() {
            println!("Failed to init AUGenericView");
            return None;
        }

        println!("Successfully created AUGenericView");
        Some(generic_view)
    }
}

/// Create a placeholder view when no custom UI is available
fn create_placeholder_view(window: &NSWindow, text: &str, _mtm: MainThreadMarker) {
    unsafe {
        // Create a text field as placeholder
        let text_field_class = class!(NSTextField);
        let text_field: *mut AnyObject = msg_send![text_field_class, alloc];
        let text_field: *mut AnyObject = msg_send![text_field, init];

        let ns_string = NSString::from_str(text);
        let _: () = msg_send![text_field, setStringValue: &*ns_string];
        let _: () = msg_send![text_field, setEditable: false];
        let _: () = msg_send![text_field, setBezeled: false];
        let _: () = msg_send![text_field, setDrawsBackground: false];
        let _: () = msg_send![text_field, setAlignment: 2u64]; // NSTextAlignmentCenter

        let _: () = msg_send![window, setContentView: text_field];
    }
}

/// Check if a plugin window is currently open
pub fn is_plugin_window_open(instance_id: &str) -> bool {
    if let Some(&window_number) = PLUGIN_WINDOW_NUMBERS.read().unwrap().get(instance_id) {
        // Verify window still exists
        if let Some(mtm) = MainThreadMarker::new() {
            return get_window_by_number(window_number, mtm).is_some();
        }
    }
    false
}

/// Close all open plugin windows
pub fn close_all_plugin_windows() {
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return,
    };

    let entries: Vec<(String, isize)> = PLUGIN_WINDOW_NUMBERS
        .write()
        .unwrap()
        .drain()
        .map(|(k, n)| (k, n))
        .collect();

    for (instance_id, window_number) in entries {
        remove_view_size_observer(&instance_id);

        if let Some(window) = get_window_by_number(window_number, mtm) {
            window.close();
        }
    }
}

/// Clean up cached view controller when AudioUnit instance is removed
/// This should be called when the AudioUnitInstance is dropped
pub fn cleanup_cached_view_controller(instance_id: &str) {
    // Close window if open
    close_audio_unit_ui(instance_id);

    // Release any retired view controllers for this instance (balanced with retain in request_view_controller).
    release_retired_view_controllers(instance_id);
}

/// Open plugin UI by instance_id only
///
/// This is a convenience wrapper that looks up the AudioUnit instance
/// and opens its UI. Must be called from main thread.
pub fn open_plugin_ui_by_instance_id(instance_id: &str) -> Result<(), String> {
    // Get the AudioUnit instance from manager
    let au_instance = crate::audio_unit::get_au_manager()
        .get_instance(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {}", instance_id))?;

    // Get the AUAudioUnit pointer
    let au_audio_unit = au_instance
        .get_au_audio_unit()
        .ok_or_else(|| "AudioUnit not initialized".to_string())?;

    let plugin_name = au_instance.info.name.clone();

    // Open the UI
    open_audio_unit_ui(instance_id, au_audio_unit, &plugin_name)
}
