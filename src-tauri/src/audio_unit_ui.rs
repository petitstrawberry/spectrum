//! AudioUnit UI Window
//!
//! This module creates native Cocoa windows to display AudioUnit custom views.
//! Supports both AUv2 (CocoaUI) and AUv3 (requestViewController) plugins.
//!
//! Note: NSWindow is not thread-safe, so we store window numbers (i64) instead of
//! Retained<NSWindow>. We can retrieve the window using [NSApp windowWithWindowNumber:].

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{class, msg_send, sel, MainThreadOnly, Encode, Encoding, RefEncode};
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

// Store open plugin window numbers (i64 is Send + Sync)
lazy_static::lazy_static! {
    static ref PLUGIN_WINDOW_NUMBERS: RwLock<HashMap<String, isize>> = RwLock::new(HashMap::new());
}

/// Open a native window for an AudioUnit plugin's custom view
/// 
/// This function:
/// 1. Gets the AudioUnit's CocoaUI view factory
/// 2. Creates an NSWindow
/// 3. Embeds the AudioUnit's custom view in the window
pub fn open_audio_unit_ui(
    instance_id: &str,
    audio_unit: *mut c_void,
    plugin_name: &str,
) -> Result<(), String> {
    // Must run on main thread for UI operations
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return Err("Must be called from main thread".to_string()),
    };
    
    // Check if window is already open
    if let Some(&window_number) = PLUGIN_WINDOW_NUMBERS.read().unwrap().get(instance_id) {
        // Try to bring existing window to front
        if let Some(window) = get_window_by_number(window_number, mtm) {
            window.makeKeyAndOrderFront(None);
            return Ok(());
        } else {
            // Window was closed externally, remove from tracking
            PLUGIN_WINDOW_NUMBERS.write().unwrap().remove(instance_id);
        }
    }
    
    // Create window
    let content_rect = NSRect::new(
        NSPoint::new(100.0, 100.0),
        NSSize::new(600.0, 400.0),
    );
    
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::Miniaturizable;
    
    // NSBackingStoreBuffered = 2
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            content_rect,
            style,
            NSBackingStoreType(2), // NSBackingStoreBuffered
            false,
        )
    };
    
    // Set window title
    let title = NSString::from_str(&format!("{} - Plugin", plugin_name));
    window.setTitle(&title);
    
    // Get AudioUnit's CocoaUI view
    // Note: This requires calling AudioUnitGetProperty with kAudioUnitProperty_CocoaUI
    // to get the view factory class, then instantiating it
    let view = get_audio_unit_view(audio_unit)?;
    
    if let Some(au_view) = view {
        unsafe {
            // Set the AudioUnit view as the window's content view
            let window_ptr: *const AnyObject = std::mem::transmute(&*window);
            let _: () = msg_send![window_ptr, setContentView: au_view];
        }
    } else {
        // Create a placeholder view with a message
        let label_text = format!("No custom UI available for {}", plugin_name);
        create_placeholder_view(&window, &label_text, mtm);
    }
    
    // Show window
    window.center();
    window.makeKeyAndOrderFront(None);
    
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
    
    // Must be on main thread
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return,
    };
    
    if let Some(window) = get_window_by_number(window_number, mtm) {
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

/// Get the AudioUnit's custom view
/// Uses AUv3 (requestViewController) - no fallback, we don't give up!
fn get_audio_unit_view(audio_unit: *mut c_void) -> Result<Option<*mut AnyObject>, String> {
    if audio_unit.is_null() {
        eprintln!("AudioUnit handle is null");
        return Err("AudioUnit handle is null".to_string());
    }
    
    println!("Getting AudioUnit view for handle: {:?}", audio_unit);
    
    // Use AUv3 approach - retry up to 3 times if needed
    for attempt in 1..=3 {
        println!("AUv3 view attempt {}/3", attempt);
        if let Some(view) = try_get_auv3_view(audio_unit) {
            println!("Successfully obtained AUv3 view on attempt {}", attempt);
            return Ok(Some(view));
        }
        // Brief pause before retry
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    
    println!("Failed to get AUv3 view after 3 attempts - but we don't give up!");
    // Return None but don't fall back to anything else
    Ok(None)
}

/// Try to get AUv3 view using AUAudioUnit.requestViewController
fn try_get_auv3_view(audio_unit: *mut c_void) -> Option<*mut AnyObject> {
    unsafe {
        // Get the AudioComponent from the instance
        let component = AudioComponentInstanceGetComponent(audio_unit);
        if component.is_null() {
            println!("Failed to get AudioComponent from instance");
            return None;
        }
        
        extern "C" {
            fn AudioComponentGetDescription(
                component: *mut c_void,
                desc: *mut AudioComponentDescription,
            ) -> i32;
        }
        
        let mut desc = AudioComponentDescription {
            component_type: 0,
            component_sub_type: 0,
            component_manufacturer: 0,
            component_flags: 0,
            component_flags_mask: 0,
        };
        
        let status = AudioComponentGetDescription(component, &mut desc);
        if status != 0 {
            println!("Failed to get AudioComponent description: {}", status);
            return None;
        }
        
        println!("AudioComponent description: type={:08x}, subtype={:08x}, manufacturer={:08x}", 
                 desc.component_type, desc.component_sub_type, desc.component_manufacturer);
        
        // Create an AUAudioUnit instance using the component description
        // We need to use +[AUAudioUnit instantiateWithComponentDescription:options:completionHandler:]
        // This is async - we run the RunLoop to allow callbacks on main thread
        
        let au_audio_unit_class = class!(AUAudioUnit);
        
        // Create result holder with atomic flag for completion
        let result: Arc<Mutex<Option<*mut AnyObject>>> = Arc::new(Mutex::new(None));
        let result_clone = Arc::clone(&result);
        let done = Arc::new(AtomicBool::new(false));
        let done_clone = Arc::clone(&done);
        
        // Create the completion handler block
        // void (^)(AUAudioUnit * _Nullable audioUnit, NSError * _Nullable error)
        let block = RcBlock::new(move |au_audio_unit: *mut AnyObject, error: *mut AnyObject| {
            if !error.is_null() {
                println!("AUAudioUnit instantiation error");
            }
            
            if !au_audio_unit.is_null() {
                // Retain the AUAudioUnit to prevent deallocation
                let _: () = msg_send![au_audio_unit, retain];
                *result_clone.lock().unwrap() = Some(au_audio_unit);
            }
            
            done_clone.store(true, Ordering::SeqCst);
        });
        
        // Call instantiateWithComponentDescription:options:completionHandler:
        // options = 0 (default)
        let _: () = msg_send![
            au_audio_unit_class,
            instantiateWithComponentDescription: desc
            options: 0u32
            completionHandler: &*block
        ];
        
        // Run the RunLoop to allow completion handler to be called on main thread
        let start_time = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(10);
        let mode = get_default_run_loop_mode();
        
        while !done.load(Ordering::SeqCst) {
            if start_time.elapsed() > timeout {
                println!("Timed out waiting for AUAudioUnit instantiation");
                return None;
            }
            // Run the RunLoop for a short interval to process pending events
            CFRunLoopRunInMode(mode, 0.01, false);
        }
        
        let au_audio_unit = result.lock().unwrap().take();
        
        if au_audio_unit.is_none() {
            println!("Failed to instantiate AUAudioUnit");
            return None;
        }
        
        let au_audio_unit = au_audio_unit.unwrap();
        println!("Successfully instantiated AUAudioUnit: {:?}", au_audio_unit);
        
        // Now call requestViewControllerWithCompletionHandler:
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
        
        // Verify the view controller is still valid before accessing view
        if view_controller.is_null() {
            println!("View controller became null");
            return None;
        }
        
        // Get the view from the view controller - force loadView if needed
        let _: () = msg_send![view_controller, loadViewIfNeeded];
        let view: *mut AnyObject = msg_send![view_controller, view];
        
        if view.is_null() {
            println!("View controller has no view");
            return None;
        }
        
        println!("Successfully obtained AUv3 view: {:?}", view);
        Some(view)
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
