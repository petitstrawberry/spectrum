//! AudioUnit UI Window
//!
//! This module creates native Cocoa windows to display AudioUnit custom views.
//! Supports both AUv2 (CocoaUI) and AUv3 (requestViewController) plugins.
//!
//! Note: NSWindow is not thread-safe, so we store window numbers (i64) instead of
//! Retained<NSWindow>. We can retrieve the window using [NSApp windowWithWindowNumber:].

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, MainThreadOnly, Encode, Encoding, RefEncode};
use objc2_app_kit::{NSWindow, NSWindowStyleMask, NSApplication, NSBackingStoreType};
use objc2_foundation::{NSRect, NSPoint, NSSize, NSString, MainThreadMarker};
use std::collections::HashMap;
use std::ffi::c_void;
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
            window.makeKeyAndOrderFront(None);
            return Ok(());
        } else {
            // Window was closed externally, remove from tracking
            // Keep the cached view controller for reuse
            let mut map = PLUGIN_WINDOW_NUMBERS.write().unwrap();
            map.remove(instance_id);
            drop(map);
        }
    }

    // Get AudioUnit's view using existing AUAudioUnit instance
    let view = get_audio_unit_view(instance_id, au_audio_unit)?;

    // Determine window size based on the view's size
    let (window_width, window_height) = if let Some(au_view) = view {
        unsafe {
            // Get the view's frame size
            let frame: NSRect = msg_send![au_view, frame];
            let preferred_size: NSSize = msg_send![au_view, fittingSize];

            // Use preferredContentSize if available (AUv3 view controllers often set this)
            // Otherwise fall back to frame size or fitting size
            let width = if preferred_size.width > 10.0 {
                preferred_size.width
            } else if frame.size.width > 10.0 {
                frame.size.width
            } else {
                600.0
            };

            let height = if preferred_size.height > 10.0 {
                preferred_size.height
            } else if frame.size.height > 10.0 {
                frame.size.height
            } else {
                400.0
            };

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
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::Miniaturizable;

    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            content_rect,
            style,
            NSBackingStoreType(2), // NSBackingStoreBuffered
            false,
        )
    };

    unsafe {
        // =============================
        // 【重要修正 1】ゾンビ化防止
        // =============================
        let _: () = msg_send![&*window, setReleasedWhenClosed: true];

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

        // ウィンドウレベル（常に最前面）
        let level: isize = 3; // NSFloatingWindowLevel
        window.setLevel(level);

        // ウィンドウ表示
        window.makeKeyAndOrderFront(None);

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
            // ただしプラグインが "autoresizingMask" でリサイズ対応かどうかを判定し、
            // ウィンドウのスタイル (Resizable) とプラグインの内部抵抗力を切り替える

            // autoresizingMask を読み取ってリサイズ対応か判定
            let mask: u64 = msg_send![au_view, autoresizingMask];
            // NSViewWidthSizable = 2, NSViewHeightSizable = 16
            let is_resizable = (mask & (2u64 | 16u64)) == (2u64 | 16u64);

            // ウィンドウの styleMask を取得して必要なら Resizable を付け外し
            let current_style: u64 = msg_send![&*window, styleMask];
            let resizable_flag: u64 = 8u64; // NSWindowStyleMaskResizable
            if is_resizable {
                let new_style = current_style | resizable_flag;
                let _: () = msg_send![&*window, setStyleMask: new_style];
            } else {
                let new_style = current_style & !resizable_flag;
                let _: () = msg_send![&*window, setStyleMask: new_style];
            }

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

            // プラグインの抵抗力を条件付きで設定
            let priority: f32 = if is_resizable { 250.0 } else { 1000.0 };
            let orient_h: isize = 0; // Horizontal
            let orient_v: isize = 1; // Vertical

            let _: () = msg_send![au_view, setContentHuggingPriority: priority, forOrientation: orient_h];
            let _: () = msg_send![au_view, setContentHuggingPriority: priority, forOrientation: orient_v];

            let _: () = msg_send![au_view, setContentCompressionResistancePriority: priority, forOrientation: orient_h];
            let _: () = msg_send![au_view, setContentCompressionResistancePriority: priority, forOrientation: orient_v];

            // Layer設定の再確保
            let _: () = msg_send![au_view, setWantsLayer: true];
        } else {
            // カスタムUIがない場合はプレースホルダー
            let label_text = format!("No custom UI available for {}", plugin_name);
            create_placeholder_view(&window, &label_text, mtm);
        }
    }

    // Store window number (not the window itself, as it's not Sync)
    let window_number = window.windowNumber();
    PLUGIN_WINDOW_NUMBERS.write().unwrap().insert(instance_id.to_string(), window_number);

    // We need to prevent the window from being deallocated
    // By retaining it via the application's window list
    // The window is already retained by being ordered front
    std::mem::forget(window);

    Ok(())
}

/// Close an AudioUnit UI window
pub fn close_audio_unit_ui(instance_id: &str) {
    let window_number = match PLUGIN_WINDOW_NUMBERS.write().unwrap().remove(instance_id) {
        Some(n) => n,
        None => return,
    };

    // Note: We keep the cached view controller alive so the window can be reopened.
    // The view controller will be released when the AudioUnitInstance is dropped.
    // We only need to remove the window tracking.

    // Must be on main thread
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return,
    };

    if let Some(window) = get_window_by_number(window_number, mtm) {
        unsafe {
            // Remove the content view from the window before closing
            // to prevent the view from being deallocated with the window
            let _: () = msg_send![&*window, setContentView: std::ptr::null::<AnyObject>()];
        }
        window.close();
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

    let window_numbers: Vec<isize> = PLUGIN_WINDOW_NUMBERS.write().unwrap().drain().map(|(_, n)| n).collect();

    for window_number in window_numbers {
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

    // Release cached view controller
    if let Some(SendSyncPtr(vc)) = CACHED_VIEW_CONTROLLERS.write().unwrap().remove(instance_id) {
        if !vc.is_null() {
            unsafe {
                println!("[AudioUnit] Releasing cached view controller for {}", instance_id);
                let _: () = msg_send![vc, release];
            }
        }
    }
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
