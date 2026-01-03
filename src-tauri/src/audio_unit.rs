//! AudioUnit Plugin Management
//!
//! This module handles AudioUnit discovery, instantiation, and processing.
//! Uses CoreAudio's AudioComponent API to enumerate and manage AudioUnits.

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, Encode, Encoding, RefEncode};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// CoreAudio bindings
#[allow(non_upper_case_globals)]
#[allow(non_camel_case_types)]
#[allow(non_snake_case)]
#[allow(dead_code)]
mod bindings {
    use std::os::raw::{c_char, c_void};

    pub type OSStatus = i32;
    pub type AudioComponent = *mut c_void;
    pub type AudioComponentInstance = *mut c_void;
    pub type AudioUnit = AudioComponentInstance;

    pub const noErr: OSStatus = 0;

    // AudioComponent types
    pub const kAudioUnitType_Effect: u32 = 0x61756678; // 'aufx'
    pub const kAudioUnitType_MusicEffect: u32 = 0x61756D66; // 'aumf'
    pub const kAudioUnitType_Generator: u32 = 0x6175676E; // 'augn'
    pub const kAudioUnitType_MusicDevice: u32 = 0x61756D75; // 'aumu'
    pub const kAudioUnitType_Output: u32 = 0x61756F75; // 'auou'
    pub const kAudioUnitType_Mixer: u32 = 0x61756D78; // 'aumx'

    // Apple manufacturer code
    pub const kAudioUnitManufacturer_Apple: u32 = 0x6170706C; // 'appl'

    // AudioComponent flags
    pub const kAudioComponentFlag_SandboxSafe: u32 = 1 << 1;

    // AudioUnit properties
    pub const kAudioUnitProperty_CocoaUI: u32 = 4013;

    // AudioUnit scopes
    pub const kAudioUnitScope_Global: u32 = 0;
    pub const kAudioUnitScope_Input: u32 = 1;
    pub const kAudioUnitScope_Output: u32 = 2;

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    pub struct AudioComponentDescription {
        pub componentType: u32,
        pub componentSubType: u32,
        pub componentManufacturer: u32,
        pub componentFlags: u32,
        pub componentFlagsMask: u32,
    }

    #[repr(C)]
    pub struct CFString {
        _private: [u8; 0],
    }
    pub type CFStringRef = *const CFString;

    // Render callback types
    pub type AURenderCallback = unsafe extern "C" fn(
        inRefCon: *mut c_void,
        ioActionFlags: *mut u32,
        inTimeStamp: *const AudioTimeStamp,
        inBusNumber: u32,
        inNumberFrames: u32,
        ioData: *mut AudioBufferList,
    ) -> OSStatus;

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct AURenderCallbackStruct {
        pub inputProc: AURenderCallback,
        pub inputProcRefCon: *mut c_void,
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        pub fn AudioComponentFindNext(
            inComponent: AudioComponent,
            inDesc: *const AudioComponentDescription,
        ) -> AudioComponent;

        pub fn AudioComponentCopyName(
            inComponent: AudioComponent,
            outName: *mut CFStringRef,
        ) -> OSStatus;

        pub fn AudioComponentGetDescription(
            inComponent: AudioComponent,
            outDesc: *mut AudioComponentDescription,
        ) -> OSStatus;

        pub fn AudioComponentInstanceNew(
            inComponent: AudioComponent,
            outInstance: *mut AudioComponentInstance,
        ) -> OSStatus;

        pub fn AudioComponentInstanceDispose(inInstance: AudioComponentInstance) -> OSStatus;

        pub fn AudioUnitInitialize(inUnit: AudioUnit) -> OSStatus;

        pub fn AudioUnitUninitialize(inUnit: AudioUnit) -> OSStatus;

        pub fn AudioUnitGetPropertyInfo(
            inUnit: AudioUnit,
            inID: u32,
            inScope: u32,
            inElement: u32,
            outDataSize: *mut u32,
            outWritable: *mut bool,
        ) -> OSStatus;

        pub fn AudioUnitGetProperty(
            inUnit: AudioUnit,
            inID: u32,
            inScope: u32,
            inElement: u32,
            outData: *mut c_void,
            ioDataSize: *mut u32,
        ) -> OSStatus;

        pub fn AudioUnitSetProperty(
            inUnit: AudioUnit,
            inID: u32,
            inScope: u32,
            inElement: u32,
            inData: *const c_void,
            inDataSize: u32,
        ) -> OSStatus;

        pub fn AudioUnitRender(
            inUnit: AudioUnit,
            ioActionFlags: *mut u32,
            inTimeStamp: *const AudioTimeStamp,
            inOutputBusNumber: u32,
            inNumberFrames: u32,
            ioData: *mut AudioBufferList,
        ) -> OSStatus;
    }

    // AudioTimeStamp structure
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    pub struct AudioTimeStamp {
        pub mSampleTime: f64,
        pub mHostTime: u64,
        pub mRateScalar: f64,
        pub mWordClockTime: u64,
        pub mSMPTETime: SMPTETime,
        pub mFlags: u32,
        pub mReserved: u32,
    }

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    pub struct SMPTETime {
        pub mSubframes: i16,
        pub mSubframeDivisor: i16,
        pub mCounter: u32,
        pub mType: u32,
        pub mFlags: u32,
        pub mHours: i16,
        pub mMinutes: i16,
        pub mSeconds: i16,
        pub mFrames: i16,
    }

    // AudioBuffer and AudioBufferList structures
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct AudioBuffer {
        pub mNumberChannels: u32,
        pub mDataByteSize: u32,
        pub mData: *mut c_void,
    }

    // Variable-length AudioBufferList
    #[repr(C)]
    pub struct AudioBufferList {
        pub mNumberBuffers: u32,
        pub mBuffers: [AudioBuffer; 1], // Variable length array
    }

    // Stream format constants
    pub const kAudioUnitProperty_StreamFormat: u32 = 8;
    pub const kAudioUnitProperty_MaximumFramesPerSlice: u32 = 14;
    pub const kAudioUnitProperty_SetRenderCallback: u32 = 23;

    // AudioStreamBasicDescription
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    pub struct AudioStreamBasicDescription {
        pub mSampleRate: f64,
        pub mFormatID: u32,
        pub mFormatFlags: u32,
        pub mBytesPerPacket: u32,
        pub mFramesPerPacket: u32,
        pub mBytesPerFrame: u32,
        pub mChannelsPerFrame: u32,
        pub mBitsPerChannel: u32,
        pub mReserved: u32,
    }

    // AudioTimeStamp flags
    pub const kAudioTimeStampSampleTimeValid: u32 = 1 << 0;

    // Format constants
    pub const kAudioFormatLinearPCM: u32 = 0x6C70636D; // 'lpcm'
    pub const kAudioFormatFlagIsFloat: u32 = 1 << 0;
    pub const kAudioFormatFlagIsPacked: u32 = 1 << 3;
    pub const kAudioFormatFlagIsNonInterleaved: u32 = 1 << 5;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFStringGetCString(
            theString: CFStringRef,
            buffer: *mut c_char,
            bufferSize: isize,
            encoding: u32,
        ) -> bool;

        pub fn CFRelease(cf: *const c_void);

        pub fn CFStringGetLength(theString: CFStringRef) -> isize;
    }

    pub const kCFStringEncodingUTF8: u32 = 0x08000100;
}

use bindings::*;

/// Convert FourCC u32 to readable string (e.g., 0x61756678 -> "aufx")
fn fourcc_to_string(code: u32) -> String {
    let bytes = code.to_be_bytes();
    bytes
        .iter()
        .map(|&b| {
            if b.is_ascii_graphic() || b == b' ' {
                b as char
            } else {
                '?'
            }
        })
        .collect()
}

/// Get CFString as Rust String
unsafe fn cfstring_to_string(cf_str: CFStringRef) -> Option<String> {
    if cf_str.is_null() {
        return None;
    }

    let len = CFStringGetLength(cf_str);
    if len <= 0 {
        CFRelease(cf_str as *const _);
        return None;
    }

    // Allocate buffer (UTF-8 can be up to 4 bytes per character)
    let buffer_size = (len * 4 + 1) as usize;
    let mut buffer = vec![0u8; buffer_size];

    let success = CFStringGetCString(
        cf_str,
        buffer.as_mut_ptr() as *mut _,
        buffer_size as isize,
        kCFStringEncodingUTF8,
    );

    CFRelease(cf_str as *const _);

    if success {
        let c_str = CStr::from_ptr(buffer.as_ptr() as *const _);
        c_str.to_str().ok().map(|s| s.to_string())
    } else {
        None
    }
}

/// Manufacturer code to readable name
fn manufacturer_to_string(code: u32) -> String {
    // Known manufacturers
    match code {
        0x6170706C => "Apple".to_string(), // 'appl'
        _ => fourcc_to_string(code),
    }
}

/// AudioUnit plugin info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioUnitInfo {
    /// Unique identifier (type:subtype:manufacturer)
    pub id: String,
    /// Display name
    pub name: String,
    /// Manufacturer name
    pub manufacturer: String,
    /// Plugin type (effect, instrument, generator, etc.)
    pub plugin_type: String,
    /// Component type code
    pub type_code: u32,
    /// Component subtype code
    pub subtype_code: u32,
    /// Component manufacturer code
    pub manufacturer_code: u32,
    /// Is sandbox-safe
    pub sandbox_safe: bool,
}

/// AudioUnit plugin category
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioUnitCategory {
    Effect,
    MusicEffect,
    Instrument,
    Generator,
    Mixer,
    Output,
}

impl AudioUnitCategory {
    fn component_type(&self) -> u32 {
        match self {
            AudioUnitCategory::Effect => kAudioUnitType_Effect,
            AudioUnitCategory::MusicEffect => kAudioUnitType_MusicEffect,
            AudioUnitCategory::Instrument => kAudioUnitType_MusicDevice,
            AudioUnitCategory::Generator => kAudioUnitType_Generator,
            AudioUnitCategory::Mixer => kAudioUnitType_Mixer,
            AudioUnitCategory::Output => kAudioUnitType_Output,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            AudioUnitCategory::Effect => "effect",
            AudioUnitCategory::MusicEffect => "music_effect",
            AudioUnitCategory::Instrument => "instrument",
            AudioUnitCategory::Generator => "generator",
            AudioUnitCategory::Mixer => "mixer",
            AudioUnitCategory::Output => "output",
        }
    }
}

/// Get all AudioUnits of a specific category
pub fn get_audio_units(category: AudioUnitCategory) -> Vec<AudioUnitInfo> {
    let mut result = Vec::new();

    let desc = AudioComponentDescription {
        componentType: category.component_type(),
        componentSubType: 0,
        componentManufacturer: 0,
        componentFlags: 0,
        componentFlagsMask: 0,
    };

    unsafe {
        let mut component: AudioComponent = ptr::null_mut();

        loop {
            component = AudioComponentFindNext(component, &desc);
            if component.is_null() {
                break;
            }

            // Get component description
            let mut out_desc = AudioComponentDescription::default();
            if AudioComponentGetDescription(component, &mut out_desc) != noErr {
                continue;
            }

            // Get component name
            let mut name_ref: CFStringRef = ptr::null();
            let name = if AudioComponentCopyName(component, &mut name_ref) == noErr {
                cfstring_to_string(name_ref).unwrap_or_else(|| "Unknown".to_string())
            } else {
                "Unknown".to_string()
            };

            // Parse name - usually "Manufacturer: PluginName"
            let (manufacturer_name, plugin_name) = if let Some(idx) = name.find(": ") {
                (name[..idx].to_string(), name[idx + 2..].to_string())
            } else {
                (
                    manufacturer_to_string(out_desc.componentManufacturer),
                    name.clone(),
                )
            };

            let id = format!(
                "{}:{}:{}",
                fourcc_to_string(out_desc.componentType),
                fourcc_to_string(out_desc.componentSubType),
                fourcc_to_string(out_desc.componentManufacturer),
            );

            let sandbox_safe = (out_desc.componentFlags & kAudioComponentFlag_SandboxSafe) != 0;

            result.push(AudioUnitInfo {
                id,
                name: plugin_name,
                manufacturer: manufacturer_name,
                plugin_type: category.as_str().to_string(),
                type_code: out_desc.componentType,
                subtype_code: out_desc.componentSubType,
                manufacturer_code: out_desc.componentManufacturer,
                sandbox_safe,
            });
        }
    }

    // Sort by manufacturer, then by name
    result.sort_by(|a, b| {
        a.manufacturer
            .cmp(&b.manufacturer)
            .then_with(|| a.name.cmp(&b.name))
    });

    result
}

/// Get all effect AudioUnits (both 'aufx' and 'aumf')
pub fn get_effect_audio_units() -> Vec<AudioUnitInfo> {
    let mut effects = get_audio_units(AudioUnitCategory::Effect);
    let music_effects = get_audio_units(AudioUnitCategory::MusicEffect);
    effects.extend(music_effects);

    // Re-sort after merging
    effects.sort_by(|a, b| {
        a.manufacturer
            .cmp(&b.manufacturer)
            .then_with(|| a.name.cmp(&b.name))
    });

    effects
}

/// Get all instrument AudioUnits
pub fn get_instrument_audio_units() -> Vec<AudioUnitInfo> {
    get_audio_units(AudioUnitCategory::Instrument)
}

/// Get all generator AudioUnits
pub fn get_generator_audio_units() -> Vec<AudioUnitInfo> {
    get_audio_units(AudioUnitCategory::Generator)
}

// ========== AudioUnit Instance Management ==========

/// Maximum frames per buffer for AU processing
pub const AU_MAX_FRAMES: usize = 4096;

// AudioComponentDescription for AUAudioUnit instantiation
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct AUComponentDescription {
    pub component_type: u32,
    pub component_sub_type: u32,
    pub component_manufacturer: u32,
    pub component_flags: u32,
    pub component_flags_mask: u32,
}

unsafe impl Encode for AUComponentDescription {
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

unsafe impl RefEncode for AUComponentDescription {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

// CoreFoundation RunLoop functions
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, returnAfterSourceHandled: bool)
        -> i32;
}

// Grand Central Dispatch (GCD) functions for semaphore
extern "C" {
    fn dispatch_semaphore_create(value: isize) -> *mut c_void;
    fn dispatch_semaphore_wait(semaphore: *mut c_void, timeout: u64) -> isize;
    fn dispatch_semaphore_signal(semaphore: *mut c_void) -> isize;
    fn dispatch_release(object: *mut c_void);
    fn dispatch_time(when: u64, delta: i64) -> u64;
}

const DISPATCH_TIME_FOREVER: u64 = !0;
const DISPATCH_TIME_NOW: u64 = 0;

fn get_default_run_loop_mode() -> *const c_void {
    extern "C" {
        static kCFRunLoopDefaultMode: *const c_void;
    }
    unsafe { kCFRunLoopDefaultMode }
}

// Resolve dispatch symbols at runtime via dlsym to avoid linker issues
fn resolve_dispatch_symbols() -> Option<(
    unsafe extern "C" fn() -> *mut c_void,
    unsafe extern "C" fn(*mut c_void, *mut c_void),
)> {
    use libc::{dlsym, RTLD_DEFAULT};
    use std::ffi::CString;

    unsafe {
        let name1 = CString::new("dispatch_get_main_queue").ok()?;
        let name2 = CString::new("dispatch_sync").ok()?;
        let sym1 = dlsym(RTLD_DEFAULT, name1.as_ptr());
        let sym2 = dlsym(RTLD_DEFAULT, name2.as_ptr());
        if sym1.is_null() || sym2.is_null() {
            return None;
        }
        let f1: unsafe extern "C" fn() -> *mut c_void = std::mem::transmute(sym1);
        let f2: unsafe extern "C" fn(*mut c_void, *mut c_void) = std::mem::transmute(sym2);
        Some((f1, f2))
    }
}

/// Wrapper for raw pointers to make them Send + Sync
#[derive(Clone, Copy)]
pub struct SendSyncPtr(pub *mut AnyObject);
unsafe impl Send for SendSyncPtr {}
unsafe impl Sync for SendSyncPtr {}

/// Maximum buffer size for AU processing
const AU_MAX_BUFFER_SIZE: usize = 8192;

/// Stereo AudioBufferList structure (fixed 2 channels)
/// This is heap-allocated and its address never changes
#[repr(C)]
struct StereoAudioBufferList {
    mNumberBuffers: u32,
    mBuffers: [AudioBuffer; 2],
}

impl StereoAudioBufferList {
    fn new() -> Box<Self> {
        Box::new(Self {
            mNumberBuffers: 2,
            mBuffers: [
                AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: 0,
                    mData: ptr::null_mut(),
                },
                AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: 0,
                    mData: ptr::null_mut(),
                },
            ],
        })
    }

    /// Set buffer pointers and size
    fn set_buffers(&mut self, left: *mut f32, right: *mut f32, frames: u32) {
        let byte_size = frames * 4; // sizeof(float)
        self.mBuffers[0].mData = left as *mut c_void;
        self.mBuffers[0].mDataByteSize = byte_size;
        self.mBuffers[1].mData = right as *mut c_void;
        self.mBuffers[1].mDataByteSize = byte_size;
    }

    fn as_audio_buffer_list(&mut self) -> *mut AudioBufferList {
        self as *mut StereoAudioBufferList as *mut AudioBufferList
    }
}

/// Internal buffers for input copy (to separate input from output for in-place processing)
struct InputCopyBuffers {
    left: [f32; AU_MAX_BUFFER_SIZE],
    right: [f32; AU_MAX_BUFFER_SIZE],
}

impl InputCopyBuffers {
    fn new() -> Box<Self> {
        Box::new(Self {
            left: [0.0; AU_MAX_BUFFER_SIZE],
            right: [0.0; AU_MAX_BUFFER_SIZE],
        })
    }
}

/// AUv2 input render callback function
/// Called by AudioUnit when it needs input audio during AudioUnitRender
/// The in_ref_con is a pointer to StereoAudioBufferList (input_buffer_list)
///
/// RACK STYLE: This callback copies from input_buffer_list (which points at caller's input)
/// to the AudioUnit's ioData buffers.
unsafe extern "C" fn input_render_callback(
    in_ref_con: *mut c_void,
    io_action_flags: *mut u32,
    _in_time_stamp: *const AudioTimeStamp,
    in_bus_number: u32,
    in_number_frames: u32,
    io_data: *mut AudioBufferList,
) -> OSStatus {
    if in_ref_con.is_null() || io_data.is_null() {
        if !io_action_flags.is_null() {
            *io_action_flags |= 1 << 4; // kAudioUnitRenderAction_OutputIsSilence
        }
        return noErr;
    }

    // in_ref_con points to our input_buffer_list which has mData pointing to caller's input
    let input_buffer_list = &*(in_ref_con as *const StereoAudioBufferList);
    let io_buffer_list = &mut *io_data;

    let required_bytes = in_number_frames * 4; // sizeof(float)
    let num_channels = io_buffer_list
        .mNumberBuffers
        .min(input_buffer_list.mNumberBuffers);

    // Copy from our input_buffer_list to AudioUnit's ioData
    for ch in 0..num_channels as usize {
        let src_buf = if ch == 0 {
            &input_buffer_list.mBuffers[0]
        } else {
            // Access via pointer for variable-length array safety
            &*input_buffer_list.mBuffers.as_ptr().add(ch)
        };

        let dst_buf = if ch == 0 {
            &mut io_buffer_list.mBuffers[0]
        } else {
            &mut *io_buffer_list.mBuffers.as_mut_ptr().add(ch)
        };

        if !src_buf.mData.is_null()
            && !dst_buf.mData.is_null()
            && dst_buf.mDataByteSize >= required_bytes
        {
            std::ptr::copy_nonoverlapping(
                src_buf.mData as *const u8,
                dst_buf.mData as *mut u8,
                required_bytes as usize,
            );
        }
    }

    noErr
}

/// AudioUnit instance wrapper - Lock-free design for audio thread safety
///
/// Key design:
/// - Mutable processing state wrapped in UnsafeCell for lock-free audio processing
/// - Atomic flags for enabled/configured state
/// - process() takes &self to avoid any locking on audio thread
pub struct AudioUnitInstance {
    /// AUAudioUnit instance (AUv3 Objective-C object) - used for BOTH processing and UI
    au_audio_unit: Option<SendSyncPtr>,
    /// Cached render block from AUAudioUnit (for audio processing)
    render_block: std::cell::UnsafeCell<Option<*mut c_void>>,
    /// Plugin info
    pub info: AudioUnitInfo,
    /// Enabled state (atomic for lock-free access)
    enabled: AtomicBool,
    /// Instance ID (unique per instance)
    pub instance_id: String,
    /// Whether render resources have been allocated (atomic for lock-free check)
    render_resources_allocated: AtomicBool,
    /// Processing state - wrapped in UnsafeCell for lock-free audio thread access
    /// SAFETY: Only accessed from audio thread during process(), never concurrently
    processing_state: std::cell::UnsafeCell<ProcessingState>,
}

/// Mutable state used only during process() - isolated for lock-free access
struct ProcessingState {
    /// Input buffer list - points to input_copy buffers during process()
    input_buffer_list: Box<StereoAudioBufferList>,
    /// Output buffer list - points to caller's output buffers during process()
    output_buffer_list: Box<StereoAudioBufferList>,
    /// Copy of input data (separate from output to avoid in-place issues)
    input_copy: Box<InputCopyBuffers>,
    /// Running sample position for AudioTimeStamp
    sample_position: i64,
}

// AudioUnit instances are not thread-safe by default
// We use proper synchronization in AudioUnitManager
unsafe impl Send for AudioUnitInstance {}
unsafe impl Sync for AudioUnitInstance {}

impl AudioUnitInstance {
    /// Create a new AudioUnit instance from info
    /// Uses AUAudioUnit for both processing and UI (required for AUv3 plugins)
    pub fn new(info: &AudioUnitInfo, instance_id: String) -> Result<Self, String> {
        // Create AUAudioUnit (works for both AUv2 and AUv3 plugins)
        // MUST run on main thread to avoid NSMenu issues with JUCE plugins
        let au_audio_unit = Self::create_au_audio_unit_on_main_thread(info)?;

        Self::new_with_au(info, instance_id, au_audio_unit)
    }

    /// Create a new AudioUnit instance with an already-instantiated AUAudioUnit
    /// This is used internally by async instantiation
    pub(crate) fn new_with_au(
        info: &AudioUnitInfo,
        instance_id: String,
        au_audio_unit: *mut AnyObject,
    ) -> Result<Self, String> {
        println!(
            "[AudioUnit] Created AUAudioUnit instance {:?} for {}",
            au_audio_unit, info.name
        );

        Ok(Self {
            au_audio_unit: Some(SendSyncPtr(au_audio_unit)),
            render_block: std::cell::UnsafeCell::new(None),
            info: info.clone(),
            enabled: AtomicBool::new(true),
            instance_id,
            render_resources_allocated: AtomicBool::new(false),
            processing_state: std::cell::UnsafeCell::new(ProcessingState {
                input_buffer_list: StereoAudioBufferList::new(),
                output_buffer_list: StereoAudioBufferList::new(),
                input_copy: InputCopyBuffers::new(),
                sample_position: 0,
            }),
        })
    }

    /// Create AUAudioUnit instance asynchronously on main thread (non-blocking)
    /// This is the recommended approach for better UI responsiveness
    fn create_au_audio_unit_async<F>(info: &AudioUnitInfo, callback: F)
    where
        F: FnOnce(Result<*mut AnyObject, String>) + Send + 'static,
    {
        let info = info.clone();

        println!(
            "[AudioUnit] Starting async instantiation for {} on main thread (non-blocking)",
            info.name
        );

        // Execute on main queue asynchronously
        unsafe {
            let callback_ptr = Box::into_raw(Box::new(callback));

            let block = RcBlock::new(move || {
                let result = AudioUnitInstance::create_au_audio_unit(&info);

                // Call the callback with the result
                let callback = Box::from_raw(callback_ptr);
                callback(result);
            });

            let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
            let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
        }
    }

    /// Create AUAudioUnit instance synchronously on main thread (blocking)
    /// This is required because AudioUnit instantiation affects NSMenu event handling
    /// Use create_au_audio_unit_async for better performance if possible
    fn create_au_audio_unit_on_main_thread(info: &AudioUnitInfo) -> Result<*mut AnyObject, String> {
        // Check if we're already on the main thread
        unsafe {
            let is_main_thread: bool = msg_send![class!(NSThread), isMainThread];

            if is_main_thread {
                // Already on main thread, call directly
                return Self::create_au_audio_unit(info);
            }

            // Not on main thread - dispatch synchronously to main thread
            println!("[AudioUnit] Synchronously dispatching to main thread (may block UI)...");

            // Use a semaphore to wait for completion
            let semaphore = dispatch_semaphore_create(0);
            if semaphore.is_null() {
                return Err("Failed to create semaphore".to_string());
            }

            // Result holder
            struct Context {
                info: AudioUnitInfo,
                result: Option<Result<*mut AnyObject, String>>,
                semaphore: *mut c_void,
            }

            let context = Box::into_raw(Box::new(Context {
                info: info.clone(),
                result: None,
                semaphore,
            }));

            // Create a block to execute on main thread
            let block = RcBlock::new(move || {
                let ctx = &mut *context;

                ctx.result = Some(AudioUnitInstance::create_au_audio_unit(&ctx.info));
                dispatch_semaphore_signal(ctx.semaphore);
            });

            // Schedule on main queue using NSOperationQueue
            let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
            let _: () = msg_send![main_queue, addOperationWithBlock: &*block];

            // Wait for completion
            let timeout_ns = 10_000_000_000u64; // 10 seconds
            let timeout_time = dispatch_time(DISPATCH_TIME_NOW, timeout_ns as i64);
            let wait_result = dispatch_semaphore_wait(semaphore, timeout_time);
            dispatch_release(semaphore);

            if wait_result != 0 {
                let _ = Box::from_raw(context); // Clean up
                return Err("Timed out waiting for main thread execution".to_string());
            }

            // Extract result and clean up
            let context = Box::from_raw(context);
            context.result.unwrap()
        }
    }

    /// Create AUAudioUnit instance using Objective-C API
    fn create_au_audio_unit(info: &AudioUnitInfo) -> Result<*mut AnyObject, String> {
        let desc = AUComponentDescription {
            component_type: info.type_code,
            component_sub_type: info.subtype_code,
            component_manufacturer: info.manufacturer_code,
            component_flags: 0,
            component_flags_mask: 0,
        };

        unsafe {
            let au_audio_unit_class = class!(AUAudioUnit);

            // Result holder for completion
            let result: Arc<Mutex<Option<*mut AnyObject>>> = Arc::new(Mutex::new(None));
            let result_clone = Arc::clone(&result);

            // Use dispatch_semaphore for thread-safe waiting
            let semaphore = dispatch_semaphore_create(0);
            if semaphore.is_null() {
                return Err("Failed to create dispatch semaphore".to_string());
            }

            // Create the completion handler block
            let block = RcBlock::new(
                move |au_audio_unit: *mut AnyObject, error: *mut AnyObject| {
                    println!("[AudioUnit] Completion handler called!");
                    if !error.is_null() {
                        println!("[AudioUnit] AUAudioUnit instantiation error");
                    }

                    if !au_audio_unit.is_null() {
                        // Retain the AUAudioUnit to prevent deallocation
                        let _: () = msg_send![au_audio_unit, retain];
                        *result_clone.lock().unwrap() = Some(au_audio_unit);
                        println!("[AudioUnit] AUAudioUnit retained");
                    }

                    // Signal that completion is done
                    dispatch_semaphore_signal(semaphore);
                    println!("[AudioUnit] Semaphore signaled");
                },
            );

            // Call instantiateWithComponentDescription:options:completionHandler:
            let _: () = msg_send![
                au_audio_unit_class,
                instantiateWithComponentDescription: desc
                options: 0u32
                completionHandler: &*block
            ];

            // Wait for completion with timeout (10 seconds)
            let timeout_ns = 10_000_000_000u64; // 10 seconds in nanoseconds
            let timeout_time = dispatch_time(DISPATCH_TIME_NOW, timeout_ns as i64);

            let wait_result = dispatch_semaphore_wait(semaphore, timeout_time);
            dispatch_release(semaphore);

            if wait_result != 0 {
                return Err("Timed out waiting for AUAudioUnit instantiation".to_string());
            }

            let au_audio_unit = result.lock().unwrap().take();

            match au_audio_unit {
                Some(au) => {
                    println!(
                        "[AudioUnit] Successfully instantiated AUAudioUnit: {:?}",
                        au
                    );
                    Ok(au)
                }
                None => Err("Failed to instantiate AUAudioUnit".to_string()),
            }
        }
    }

    /// Get the AUAudioUnit instance (for AUv3 UI)
    pub fn get_au_audio_unit(&self) -> Option<*mut AnyObject> {
        self.au_audio_unit.map(|p| p.0)
    }

    /// Get the plugin's full state (all parameters and data) as a plist data
    /// Returns None if no AUAudioUnit or if state couldn't be retrieved
    pub fn get_full_state(&self) -> Option<Vec<u8>> {
        let au = self.au_audio_unit?.0;
        if au.is_null() {
            return None;
        }

        unsafe {
            // Get fullState property (NSDictionary*)
            let full_state: *mut AnyObject = msg_send![au, fullState];
            if full_state.is_null() {
                println!("[AudioUnit] fullState is nil for {}", self.info.name);
                return None;
            }

            // Convert NSDictionary to plist data using NSPropertyListSerialization
            let plist_class = class!(NSPropertyListSerialization);
            let error_ptr: *mut *mut AnyObject = &mut std::ptr::null_mut();

            // dataWithPropertyList:format:options:error:
            // format = NSPropertyListBinaryFormat_v1_0 = 200
            let plist_data: *mut AnyObject = msg_send![
                plist_class,
                dataWithPropertyList: full_state
                format: 200i64
                options: 0i64
                error: error_ptr
            ];

            if plist_data.is_null() {
                println!(
                    "[AudioUnit] Failed to serialize fullState for {}",
                    self.info.name
                );
                return None;
            }

            // Get bytes from NSData
            let length: usize = msg_send![plist_data, length];
            let bytes: *const u8 = msg_send![plist_data, bytes];

            if bytes.is_null() || length == 0 {
                println!("[AudioUnit] Empty plist data for {}", self.info.name);
                return None;
            }

            let data = std::slice::from_raw_parts(bytes, length).to_vec();
            println!(
                "[AudioUnit] Got fullState ({} bytes) for {}",
                data.len(),
                self.info.name
            );
            Some(data)
        }
    }

    /// Set the plugin's full state from plist data
    /// Returns true if successful
    pub fn set_full_state(&mut self, data: &[u8]) -> bool {
        let au = match self.au_audio_unit {
            Some(SendSyncPtr(au)) if !au.is_null() => au,
            _ => return false,
        };

        if data.is_empty() {
            return false;
        }

        unsafe {
            // Create NSData from bytes
            let ns_data_class = class!(NSData);
            let ns_data: *mut AnyObject = msg_send![
                ns_data_class,
                dataWithBytes: data.as_ptr()
                length: data.len()
            ];

            if ns_data.is_null() {
                println!("[AudioUnit] Failed to create NSData for {}", self.info.name);
                return false;
            }

            // Parse plist data to NSDictionary using NSPropertyListSerialization
            let plist_class = class!(NSPropertyListSerialization);
            let error_ptr: *mut *mut AnyObject = &mut std::ptr::null_mut();

            // propertyListWithData:options:format:error:
            // options = NSPropertyListImmutable = 0
            let mut format: i64 = 0;
            let full_state: *mut AnyObject = msg_send![
                plist_class,
                propertyListWithData: ns_data
                options: 0i64
                format: &mut format as *mut i64
                error: error_ptr
            ];

            if full_state.is_null() {
                println!(
                    "[AudioUnit] Failed to parse plist data for {}",
                    self.info.name
                );
                return false;
            }

            // Set fullState property
            let _: () = msg_send![au, setFullState: full_state];
            println!(
                "[AudioUnit] Set fullState ({} bytes) for {}",
                data.len(),
                self.info.name
            );
            true
        }
    }

    /// Configure the AudioUnit for processing using AUv3 API
    /// This uses AUAudioUnit's allocateRenderResources and internalRenderBlock
    /// Must be called before process() with the current sample rate and max frames
    /// NOTE: Must be called from main thread only, never concurrently with process()
    pub fn configure(
        &mut self,
        sample_rate: f64,
        max_frames: u32,
        _channels: u32,
    ) -> Result<(), String> {
        let au = match self.au_audio_unit {
            Some(SendSyncPtr(au)) if !au.is_null() => au,
            _ => return Err("No AUAudioUnit instance".to_string()),
        };

        unsafe {
            // Deallocate existing resources if any
            if self.render_resources_allocated.load(Ordering::Acquire) {
                let _: () = msg_send![au, deallocateRenderResources];
                self.render_resources_allocated
                    .store(false, Ordering::Release);
                *self.render_block.get() = None;
            }

            // Set maximumFramesToRender
            let _: () = msg_send![au, setMaximumFramesToRender: max_frames as u64];

            // Get input and output busses
            let input_busses: *mut AnyObject = msg_send![au, inputBusses];
            let output_busses: *mut AnyObject = msg_send![au, outputBusses];

            // Create AVAudioFormat for stereo non-interleaved float
            let av_audio_format_class = class!(AVAudioFormat);
            let format: *mut AnyObject = msg_send![av_audio_format_class, alloc];
            // initStandardFormatWithSampleRate:channels: creates non-interleaved float format
            let format: *mut AnyObject = msg_send![
                format,
                initStandardFormatWithSampleRate: sample_rate
                channels: 2u32
            ];

            if format.is_null() {
                return Err("Failed to create AVAudioFormat".to_string());
            }

            // Set format on input bus 0 and ENABLE it
            let input_bus_count: usize = msg_send![input_busses, count];
            if input_bus_count > 0 {
                let input_bus: *mut AnyObject =
                    msg_send![input_busses, objectAtIndexedSubscript: 0usize];
                if !input_bus.is_null() {
                    // Enable the input bus first - this is REQUIRED for effect plugins
                    let _: () = msg_send![input_bus, setEnabled: true];

                    let mut error: *mut AnyObject = std::ptr::null_mut();
                    let success: bool =
                        msg_send![input_bus, setFormat: format error: &mut error as *mut _];
                    if !success {
                        println!(
                            "[AudioUnit] Warning: Failed to set input format for {}",
                            self.info.name
                        );
                    } else {
                        println!(
                            "[AudioUnit] Input bus 0 enabled and format set for {}",
                            self.info.name
                        );
                    }
                }
            }

            // Set format on output bus 0
            let output_bus_count: usize = msg_send![output_busses, count];
            if output_bus_count > 0 {
                let output_bus: *mut AnyObject =
                    msg_send![output_busses, objectAtIndexedSubscript: 0usize];
                if !output_bus.is_null() {
                    let mut error: *mut AnyObject = std::ptr::null_mut();
                    let success: bool =
                        msg_send![output_bus, setFormat: format error: &mut error as *mut _];
                    if !success {
                        println!(
                            "[AudioUnit] Warning: Failed to set output format for {}",
                            self.info.name
                        );
                    }
                }
            }

            // Release format
            let _: () = msg_send![format, release];

            // Allocate render resources
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let success: bool =
                msg_send![au, allocateRenderResourcesAndReturnError: &mut error as *mut _];

            if !success {
                let error_desc: *mut AnyObject = if !error.is_null() {
                    msg_send![error, localizedDescription]
                } else {
                    std::ptr::null_mut()
                };
                let desc = if !error_desc.is_null() {
                    let utf8: *const i8 = msg_send![error_desc, UTF8String];
                    if !utf8.is_null() {
                        std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string()
                    } else {
                        "Unknown error".to_string()
                    }
                } else {
                    "Unknown error".to_string()
                };
                return Err(format!("Failed to allocate render resources: {}", desc));
            }

            // Get the render block (not internalRenderBlock - renderBlock is meant to be called externally)
            // This is an Objective-C block that we'll call for processing
            let render_block: *mut c_void = msg_send![au, renderBlock];
            if render_block.is_null() {
                return Err("Failed to get renderBlock".to_string());
            }

            // Retain the block
            extern "C" {
                fn _Block_copy(block: *const c_void) -> *mut c_void;
            }
            let render_block = _Block_copy(render_block);

            // SAFETY: configure is called from main thread only, never concurrently with process
            *self.render_block.get() = Some(render_block);
            self.render_resources_allocated
                .store(true, Ordering::Release);

            println!(
                "[AudioUnit] Configured {} @ {}Hz, {} frames (AUv3 API, renderBlock={:?})",
                self.info.name, sample_rate, max_frames, render_block
            );
            Ok(())
        }
    }

    /// Process audio through this AudioUnit using AUv3 renderBlock
    /// LOCK-FREE: Takes &self, all mutable state is in UnsafeCell
    /// Zero-copy output: output buffers point directly to caller's buffers
    /// SAFETY: Only called from audio thread, never concurrently
    #[inline]
    pub fn process(
        &self,
        left: &mut [f32],
        right: &mut [f32],
        _sample_time: f64,
    ) -> Result<(), String> {
        if !self.enabled.load(Ordering::Relaxed) {
            return Ok(());
        }

        // SAFETY: render_block is only written by configure() on main thread,
        // and read here on audio thread. Atomic flag ensures visibility.
        let render_block = unsafe {
            match *self.render_block.get() {
                Some(block) if !block.is_null() => block,
                _ => return Err("AudioUnit not configured".to_string()),
            }
        };

        let frames = left.len().min(right.len()).min(AU_MAX_BUFFER_SIZE) as u32;
        if frames == 0 {
            return Ok(());
        }

        unsafe {
            // SAFETY: processing_state is only accessed from audio thread during process()
            let state = &mut *self.processing_state.get();

            // Copy input to internal buffer (required: input and output may be same buffer)
            let frames_usize = frames as usize;
            state.input_copy.left[..frames_usize].copy_from_slice(&left[..frames_usize]);
            state.input_copy.right[..frames_usize].copy_from_slice(&right[..frames_usize]);

            // Set up input buffer list pointing to our copy
            state.input_buffer_list.set_buffers(
                state.input_copy.left.as_mut_ptr(),
                state.input_copy.right.as_mut_ptr(),
                frames,
            );

            // Set up output buffer list pointing directly to caller's buffers (zero-copy output)
            state
                .output_buffer_list
                .set_buffers(left.as_mut_ptr(), right.as_mut_ptr(), frames);

            // Minimal timestamp - only sample time is needed
            let timestamp = AudioTimeStamp {
                mSampleTime: state.sample_position as f64,
                mFlags: kAudioTimeStampSampleTimeValid,
                ..Default::default()
            };

            let mut action_flags: u32 = 0;

            // Get pointer to input buffer list (stable address - Box on heap)
            let input_buffer_ptr = state.input_buffer_list.as_audio_buffer_list();

            // Block with captured variable - input buffer pointer embedded in block
            #[repr(C)]
            struct BlockDescriptor {
                reserved: u64,
                size: u64,
            }

            type PullInputBlockFn = unsafe extern "C" fn(
                block: *const PullInputBlockWithCapture,
                action_flags: *mut u32,
                timestamp: *const AudioTimeStamp,
                frame_count: u32,
                input_bus: i64,
                input_data: *mut AudioBufferList,
            ) -> i32;

            // Block WITH captured variable (input buffer pointer)
            #[repr(C)]
            struct PullInputBlockWithCapture {
                isa: *const c_void,
                flags: i32,
                reserved: i32,
                invoke: PullInputBlockFn,
                descriptor: *const BlockDescriptor,
                // Captured variable - pointer to our input buffer list
                input_buffer: *mut AudioBufferList,
            }

            // Pull callback that reads captured pointer from block
            unsafe extern "C" fn pull_input_callback(
                block: *const PullInputBlockWithCapture,
                action_flags: *mut u32,
                _timestamp: *const AudioTimeStamp,
                frame_count: u32,
                _input_bus: i64,
                input_data: *mut AudioBufferList,
            ) -> i32 {
                // Read input buffer pointer from captured variable in block
                let src = (*block).input_buffer;
                if input_data.is_null() || src.is_null() {
                    return 0;
                }

                // DEBUG logging disabled for performance
                // static DEBUG_COUNTER: std::sync::atomic::AtomicU32 = ...;

                let bytes = (frame_count * 4) as usize;

                // Get buffer counts
                let src_count = (*src).mNumberBuffers as usize;
                let dst_count = (*input_data).mNumberBuffers as usize;
                let n = src_count.min(dst_count);

                // Get base pointers to buffer arrays
                let src_buffers = (*src).mBuffers.as_ptr();
                let dst_buffers = (*input_data).mBuffers.as_mut_ptr();

                // Copy each channel
                for i in 0..n {
                    let s = &*src_buffers.add(i);
                    let d = &mut *dst_buffers.add(i);
                    if !s.mData.is_null() && !d.mData.is_null() && d.mDataByteSize >= bytes as u32 {
                        std::ptr::copy_nonoverlapping(
                            s.mData as *const u8,
                            d.mData as *mut u8,
                            bytes,
                        );
                    }
                }

                if !action_flags.is_null() {
                    *action_flags = 0;
                }
                0
            }

            static BLOCK_DESC: BlockDescriptor = BlockDescriptor {
                reserved: 0,
                size: std::mem::size_of::<PullInputBlockWithCapture>() as u64,
            };

            extern "C" {
                static _NSConcreteStackBlock: *const c_void;
            }

            // Create block with captured input buffer pointer
            // Stack block is valid for duration of this function call
            let pull_block = PullInputBlockWithCapture {
                isa: _NSConcreteStackBlock,
                flags: 0, // Stack block, no copy/dispose needed as it won't outlive this scope
                reserved: 0,
                invoke: pull_input_callback,
                descriptor: &BLOCK_DESC,
                input_buffer: input_buffer_ptr,
            };

            // RenderBlock structure
            #[repr(C)]
            struct RenderBlock {
                isa: *const c_void,
                flags: i32,
                reserved: i32,
                invoke: unsafe extern "C" fn(
                    block: *const RenderBlock,
                    action_flags: *mut u32,
                    timestamp: *const AudioTimeStamp,
                    frame_count: u32,
                    output_bus: i64,
                    output_data: *mut AudioBufferList,
                    pull_input_block: *const PullInputBlockWithCapture,
                ) -> i32,
            }

            let render_block_ptr = render_block as *const RenderBlock;

            // Save original output pointers - AU might replace them with its own buffers
            let orig_left_ptr = left.as_mut_ptr();
            let orig_right_ptr = right.as_mut_ptr();

            let output_buffer_list_ptr = state.output_buffer_list.as_audio_buffer_list();

            let status = ((*render_block_ptr).invoke)(
                render_block_ptr,
                &mut action_flags,
                &timestamp,
                frames,
                0,
                output_buffer_list_ptr,
                &pull_block,
            );

            state.sample_position += frames as i64;

            if status != 0 {
                return Err(format!("render failed: {}", status));
            }

            // DEBUG: Check output buffer state after render
            static DEBUG_OUTPUT_COUNTER: std::sync::atomic::AtomicU32 =
                std::sync::atomic::AtomicU32::new(0);
            let out_count = DEBUG_OUTPUT_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            // Check if AudioUnit replaced output buffer pointers
            // Some plugins write to their own internal buffers instead of ours
            let output_list = &*output_buffer_list_ptr;
            let frames_usize = frames as usize;

            // Get buffer info (debug logging disabled)
            let buf0 = &output_list.mBuffers[0];
            let buf1_ptr = (output_list.mBuffers.as_ptr()).add(1);
            let buf1 = &*buf1_ptr;
            let _ = out_count; // suppress warning

            // Left channel
            if output_list.mNumberBuffers >= 1 {
                let buf0 = &output_list.mBuffers[0];
                if !buf0.mData.is_null() && buf0.mData != orig_left_ptr as *mut c_void {
                    // AU used its own buffer - copy data back
                    std::ptr::copy_nonoverlapping(
                        buf0.mData as *const f32,
                        orig_left_ptr,
                        frames_usize,
                    );
                }
            }

            // Right channel (index 1 in our StereoAudioBufferList)
            if output_list.mNumberBuffers >= 2 {
                // Need to access second buffer - but AudioBufferList only has [1] array
                // Use pointer arithmetic to get second buffer
                let buf1_ptr = (output_list.mBuffers.as_ptr()).add(1);
                let buf1 = &*buf1_ptr;
                if !buf1.mData.is_null() && buf1.mData != orig_right_ptr as *mut c_void {
                    // AU used its own buffer - copy data back
                    std::ptr::copy_nonoverlapping(
                        buf1.mData as *const f32,
                        orig_right_ptr,
                        frames_usize,
                    );
                }
            }

            Ok(())
        }
    }

    /// Process audio through this AudioUnit using input callback pattern
    /// This is the preferred way to process effects - provide input data, get processed output
    pub fn process_with_input(
        &self,
        input_left: &[f32],
        input_right: &[f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
        sample_time: f64,
    ) -> Result<(), String> {
        if !self.enabled.load(Ordering::Relaxed) {
            // Pass through
            output_left.copy_from_slice(input_left);
            output_right.copy_from_slice(input_right);
            return Ok(());
        }

        let frames = input_left
            .len()
            .min(input_right.len())
            .min(output_left.len())
            .min(output_right.len()) as u32;

        if frames == 0 {
            return Ok(());
        }

        // Copy input to output first (for in-place processing)
        output_left[..frames as usize].copy_from_slice(&input_left[..frames as usize]);
        output_right[..frames as usize].copy_from_slice(&input_right[..frames as usize]);

        // Process in place
        self.process(
            &mut output_left[..frames as usize],
            &mut output_right[..frames as usize],
            sample_time,
        )
    }
}

impl Drop for AudioUnitInstance {
    fn drop(&mut self) {
        unsafe {
            // Release render block if held
            // SAFETY: In drop, we have exclusive access
            let render_block = (*self.render_block.get()).take();
            if let Some(block) = render_block {
                if !block.is_null() {
                    extern "C" {
                        fn _Block_release(block: *const c_void);
                    }
                    _Block_release(block);
                }
            }

            // Deallocate render resources and release AUAudioUnit
            // MUST be done on main thread to avoid crashes in plugin destructors
            if let Some(SendSyncPtr(au)) = self.au_audio_unit.take() {
                if !au.is_null() {
                    let is_main_thread: bool = msg_send![class!(NSThread), isMainThread];
                    let render_resources_allocated =
                        self.render_resources_allocated.load(Ordering::Acquire);

                    if is_main_thread {
                        // Already on main thread, release directly
                        if render_resources_allocated {
                            let _: () = msg_send![au, deallocateRenderResources];
                        }
                        println!("[AudioUnit] Releasing AUAudioUnit: {:?}", au);
                        let _: () = msg_send![au, release];
                    } else {
                        // Not on main thread - dispatch synchronously to main thread using semaphore
                        println!(
                            "[AudioUnit] Synchronously releasing AUAudioUnit on main thread: {:?}",
                            au
                        );

                        // Create semaphore for synchronous wait
                        let semaphore = dispatch_semaphore_create(0);
                        let semaphore_signal = semaphore;

                        use block2::RcBlock;
                        use objc2::class;
                        use objc2::runtime::AnyObject;

                        let block = RcBlock::new(move || {
                            if render_resources_allocated {
                                let _: () = msg_send![au, deallocateRenderResources];
                            }
                            println!("[AudioUnit] Releasing AUAudioUnit on main thread: {:?}", au);
                            let _: () = msg_send![au, release];

                            // Signal completion
                            dispatch_semaphore_signal(semaphore_signal);
                        });

                        let main_queue: *mut AnyObject =
                            msg_send![class!(NSOperationQueue), mainQueue];
                        let _: () = msg_send![main_queue, addOperationWithBlock: &*block];

                        // Wait for completion (10 second timeout)
                        let timeout = dispatch_time(DISPATCH_TIME_NOW, 10_000_000_000); // 10 seconds
                        let result = dispatch_semaphore_wait(semaphore, timeout);
                        if result != 0 {
                            eprintln!("[AudioUnit] WARNING: Timed out waiting for AudioUnit cleanup on main thread");
                        }
                        dispatch_release(semaphore);
                    }
                }
            }
        }
    }
}

/// Manager for AudioUnit instances - Lock-free audio processing design
///
/// Design:
/// - Instances stored as Arc<AudioUnitInstance> directly (no inner RwLock)
/// - process_chain() is completely lock-free - just dereferences Arc pointers
/// - Instance add/remove uses outer RwLock but these are never called from audio thread
/// - AudioUnitInstance.process() takes &self (lock-free via UnsafeCell)
pub struct AudioUnitManager {
    /// Instances by ID - outer lock only for add/remove (never on audio thread)
    /// Inner Arc<AudioUnitInstance> has no locks, process() takes &self
    /// Wrapped in Arc to allow cloning in async operations
    instances: Arc<RwLock<HashMap<String, Arc<AudioUnitInstance>>>>,
    /// Counter for unique instance IDs
    counter: std::sync::atomic::AtomicU64,
}

impl AudioUnitManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(RwLock::new(HashMap::new())),
            counter: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Create a new AudioUnit instance
    /// NOTE: Called from main thread only, never from audio thread
    /// Automatically configures the instance for 48kHz stereo processing
    pub fn create_instance(&self, info: &AudioUnitInfo) -> Result<String, String> {
        let id = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let instance_id = format!("au_{}", id);

        let mut instance = AudioUnitInstance::new(info, instance_id.clone())?;

        // Pre-configure the instance for audio processing. This is a critical step.
        instance.configure(48000.0, 1024, 2)?;

        self.instances
            .write()
            .insert(instance_id.clone(), Arc::new(instance));

        // Debug log: instance created and current count
        let count = self.instances.read().len();
        println!(
            "[AudioUnit] create_instance -> {} (total={})",
            instance_id, count
        );

        Ok(instance_id)
    }

    /// Create a new AudioUnit instance asynchronously (non-blocking, better UI responsiveness)
    /// NOTE: Called from main thread only, never from audio thread
    /// Automatically configures the instance for 48kHz stereo processing
    /// The callback will be called with the result once instantiation completes
    pub fn create_instance_async<F>(&self, info: &AudioUnitInfo, callback: F)
    where
        F: FnOnce(Result<String, String>) + Send + 'static,
    {
        let id = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let instance_id = format!("au_{}", id);

        let instances = self.instances.clone();
        let info_clone = info.clone();
        let info_clone2 = info.clone(); // Clone again for the closure
        let instance_id_clone = instance_id.clone();

        // Start async instantiation
        AudioUnitInstance::create_au_audio_unit_async(&info_clone, move |result| {
            match result {
                Ok(au_audio_unit) => {
                    // Create instance with the AU
                    match AudioUnitInstance::new_with_au(
                        &info_clone2,
                        instance_id_clone.clone(),
                        au_audio_unit,
                    ) {
                        Ok(mut instance) => {
                            // Pre-configure the instance
                            match instance.configure(48000.0, 1024, 2) {
                                Ok(()) => {
                                    instances
                                        .write()
                                        .insert(instance_id_clone.clone(), Arc::new(instance));

                                    let count = instances.read().len();
                                    println!(
                                        "[AudioUnit] create_instance_async -> {} (total={})",
                                        instance_id_clone, count
                                    );

                                    callback(Ok(instance_id_clone));
                                }
                                Err(e) => {
                                    println!("[AudioUnit] Failed to configure instance: {}", e);
                                    callback(Err(e));
                                }
                            }
                        }
                        Err(e) => {
                            println!("[AudioUnit] Failed to create instance: {}", e);
                            callback(Err(e));
                        }
                    }
                }
                Err(e) => {
                    println!("[AudioUnit] Failed to instantiate AU: {}", e);
                    callback(Err(e));
                }
            }
        });
    }

    /// Get an instance by ID (for UI and configuration - not audio thread)
    pub fn get_instance(&self, id: &str) -> Option<Arc<AudioUnitInstance>> {
        self.instances.read().get(id).cloned()
    }

    /// Remove an instance
    /// NOTE: Called from main thread only, never from audio thread
    pub fn remove_instance(&self, id: &str) -> bool {
        // Clean up cached view controller before removing the instance
        crate::audio_unit_ui::cleanup_cached_view_controller(id);
        let removed = self.instances.write().remove(id).is_some();
        if removed {
            let count = self.instances.read().len();
            println!(
                "[AudioUnit] remove_instance -> {} (remaining={})",
                id, count
            );
        } else {
            println!("[AudioUnit] remove_instance -> {} (not found)", id);
        }
        removed
    }

    /// Remove and release all instances
    /// NOTE: Called from main thread only. Ensures UI controllers are cleaned up.
    /// IMPORTANT: Must be called on main thread to avoid crashes in plugin destructors
    pub fn remove_all_instances(&self) {
        unsafe {
            let is_main_thread: bool = msg_send![class!(NSThread), isMainThread];
            if !is_main_thread {
                eprintln!("[AudioUnit] WARNING: remove_all_instances called from non-main thread!");
            }
        }

        // Collect IDs to avoid holding write lock while calling cleanup
        let ids: Vec<String> = {
            let inst = self.instances.read();
            inst.keys().cloned().collect()
        };

        for id in ids {
            // Clean up any cached UI controller
            crate::audio_unit_ui::cleanup_cached_view_controller(&id);
            // Remove instance (drop will release AU resources on main thread)
            self.instances.write().remove(&id);
            println!("[AudioUnit] Removed instance {} during shutdown", id);
        }
    }

    /// Set enabled state - atomic, lock-free
    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        if let Some(instance) = self.instances.read().get(id) {
            instance.enabled.store(enabled, Ordering::Release);
            true
        } else {
            false
        }
    }

    /// List all instances
    pub fn list_instances(&self) -> Vec<(String, AudioUnitInfo, bool)> {
        self.instances
            .read()
            .iter()
            .map(|(id, inst)| {
                (
                    id.clone(),
                    inst.info.clone(),
                    inst.enabled.load(Ordering::Relaxed),
                )
            })
            .collect()
    }

    /// Configure all instances for processing
    /// NOTE: Called from main thread only, never from audio thread
    pub fn configure_all(&self, sample_rate: f64, max_frames: u32, channels: u32) {
        let instances = self.instances.read();
        for (id, instance) in instances.iter() {
            // SAFETY: configure is only called from main thread, never concurrently with process
            // We need mutable access, so we use unsafe here
            let inst_ptr = Arc::as_ptr(instance) as *mut AudioUnitInstance;
            unsafe {
                if let Err(e) = (*inst_ptr).configure(sample_rate, max_frames, channels) {
                    println!("[AudioUnit] Failed to configure {}: {}", id, e);
                }
            }
        }
    }

    /// Process audio through a chain of plugins (by instance IDs)
    /// Returns true if any processing was done
    ///
    /// LOCK-FREE: This method uses NO locks on the audio thread
    /// - Reads instance pointers from Arc (no lock needed)
    /// - Calls process() which takes &self (no lock needed)
    /// - Auto-configure skipped on audio thread to avoid potential issues
    #[inline]
    pub fn process_chain(
        &self,
        plugin_ids: &[String],
        left: &mut [f32],
        right: &mut [f32],
        sample_time: f64,
    ) -> bool {
        if plugin_ids.is_empty() {
            return false;
        }

        // Take a snapshot of the instances map
        // This read() is fast (parking_lot) but if concerned, could use arc-swap for true lock-free
        let instances = self.instances.read();
        let mut processed = false;

        for plugin_id in plugin_ids {
            if let Some(instance) = instances.get(plugin_id) {
                // Check if configured using atomic flag - no lock
                if !instance.render_resources_allocated.load(Ordering::Acquire) {
                    // Skip unconfigured plugins on audio thread
                    // They should be pre-configured via configure_all() on main thread
                    continue;
                }

                // Check enabled state - atomic, no lock
                if !instance.enabled.load(Ordering::Relaxed) {
                    continue;
                }

                // Call process() - takes &self, completely lock-free
                if instance.process(left, right, sample_time).is_ok() {
                    processed = true;
                }
            }
        }

        processed
    }

    /// Collect current fullState data for all instances
    /// Returns a map from instance_id -> Option<Vec<u8>> (None if no state)
    pub fn collect_all_instance_states(
        &self,
    ) -> std::collections::HashMap<String, Option<Vec<u8>>> {
        use std::sync::{Arc, Mutex};

        // Result container shared between threads
        let result: Arc<Mutex<std::collections::HashMap<String, Option<Vec<u8>>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let result_for_block = Arc::clone(&result);
        let result_for_fallback = Arc::clone(&result);

        // We need to call Objective-C APIs (`-fullState` / NSPropertyListSerialization)
        // on the main thread. Use dispatch_sync to synchronously run a block on the
        // main queue and populate the result map there.

        let mgr_ptr = self as *const AudioUnitManager as *mut AudioUnitManager;
        let block = RcBlock::new(move || {
            let mgr = unsafe { &*mgr_ptr };
            let instances = mgr.instances.read();
            for (id, inst) in instances.iter() {
                let state = inst.get_full_state();
                result_for_block.lock().unwrap().insert(id.clone(), state);
            }
        });

        // Try to resolve dispatch symbols dynamically and call dispatch_sync on main queue.
        if let Some((dispatch_get_main_queue_fn, dispatch_sync_fn)) = resolve_dispatch_symbols() {
            unsafe {
                let q = dispatch_get_main_queue_fn();
                dispatch_sync_fn(q, &*block as *const _ as *mut c_void);
            }
        } else {
            // Fallback: attempt to run the block on the current run loop briefly
            // This is less reliable but better than nothing; populate from current thread.
            let mgr = unsafe { &*mgr_ptr };
            let instances = mgr.instances.read();
            for (id, inst) in instances.iter() {
                let state = inst.get_full_state();
                result_for_fallback
                    .lock()
                    .unwrap()
                    .insert(id.clone(), state);
            }
        }

        // Return cloned map
        let map = result.lock().unwrap().clone();
        map
    }

    /// Set fullState data for a specific instance.
    ///
    /// The underlying Objective-C APIs must run on the main thread.
    pub fn set_instance_full_state(&self, instance_id: &str, data: &[u8]) -> bool {
        use std::sync::{Arc, Mutex};

        if data.is_empty() {
            return false;
        }

        // Grab an Arc clone up-front so we don't touch the manager inside the main-thread block.
        let Some(instance) = self.get_instance(instance_id) else {
            return false;
        };

        let result: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
        let result_for_block = Arc::clone(&result);
        let result_for_fallback = Arc::clone(&result);
        let bytes: Arc<Vec<u8>> = Arc::new(data.to_vec());
        let bytes_for_block = Arc::clone(&bytes);

        // Run Objective-C calls on main thread.
        let inst_ptr = Arc::as_ptr(&instance) as *mut AudioUnitInstance;
        let block = RcBlock::new(move || {
            // SAFETY: this runs on main thread; caller should not run concurrently with audio processing setup.
            let ok = unsafe { (*inst_ptr).set_full_state(bytes_for_block.as_slice()) };
            *result_for_block.lock().unwrap() = ok;
        });

        if let Some((dispatch_get_main_queue_fn, dispatch_sync_fn)) = resolve_dispatch_symbols() {
            unsafe {
                let q = dispatch_get_main_queue_fn();
                dispatch_sync_fn(q, &*block as *const _ as *mut c_void);
            }
        } else {
            // Best-effort fallback on current thread.
            let ok = unsafe { (*inst_ptr).set_full_state(bytes.as_slice()) };
            *result_for_fallback.lock().unwrap() = ok;
        }

        let ok = *result.lock().unwrap();
        ok
    }
}

// Global AudioUnit manager
lazy_static::lazy_static! {
    pub static ref AU_MANAGER: AudioUnitManager = AudioUnitManager::new();
}

/// Get global AudioUnit manager
pub fn get_au_manager() -> &'static AudioUnitManager {
    &AU_MANAGER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_effects() {
        let effects = get_effect_audio_units();
        println!("Found {} effects", effects.len());
        for au in effects.iter().take(10) {
            println!("  {} - {} ({})", au.manufacturer, au.name, au.id);
        }
        assert!(!effects.is_empty(), "Should find at least one effect");
    }

    #[test]
    fn test_fourcc() {
        assert_eq!(fourcc_to_string(0x61756678), "aufx");
        assert_eq!(fourcc_to_string(0x6170706C), "appl");
    }
}
