//! AudioUnit Plugin Management
//! 
//! This module handles AudioUnit discovery, instantiation, and processing.
//! Uses CoreAudio's AudioComponent API to enumerate and manage AudioUnits.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::CStr;
use std::ptr;
use std::sync::Arc;

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
        
        pub fn AudioComponentInstanceDispose(
            inInstance: AudioComponentInstance,
        ) -> OSStatus;
        
        pub fn AudioUnitInitialize(
            inUnit: AudioUnit,
        ) -> OSStatus;
        
        pub fn AudioUnitUninitialize(
            inUnit: AudioUnit,
        ) -> OSStatus;
        
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
    }
    
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
    bytes.iter()
        .map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '?' })
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
                (manufacturer_to_string(out_desc.componentManufacturer), name.clone())
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
        a.manufacturer.cmp(&b.manufacturer)
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
        a.manufacturer.cmp(&b.manufacturer)
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

/// AudioUnit instance wrapper
pub struct AudioUnitInstance {
    /// AudioUnit handle
    unit: AudioComponentInstance,
    /// Plugin info
    pub info: AudioUnitInfo,
    /// Enabled state
    pub enabled: bool,
    /// Instance ID (unique per instance)
    pub instance_id: String,
}

// AudioUnit instances are not thread-safe by default
// We use proper synchronization in AudioUnitManager
unsafe impl Send for AudioUnitInstance {}
unsafe impl Sync for AudioUnitInstance {}

impl AudioUnitInstance {
    /// Create a new AudioUnit instance from info
    pub fn new(info: &AudioUnitInfo, instance_id: String) -> Result<Self, String> {
        // Find the component
        let desc = AudioComponentDescription {
            componentType: info.type_code,
            componentSubType: info.subtype_code,
            componentManufacturer: info.manufacturer_code,
            componentFlags: 0,
            componentFlagsMask: 0,
        };
        
        unsafe {
            let component = AudioComponentFindNext(ptr::null_mut(), &desc);
            if component.is_null() {
                return Err(format!("AudioUnit component not found: {}", info.id));
            }
            
            let mut instance: AudioComponentInstance = ptr::null_mut();
            let status = AudioComponentInstanceNew(component, &mut instance);
            if status != noErr {
                return Err(format!("Failed to instantiate AudioUnit: OSStatus {}", status));
            }
            
            println!("[AudioUnit] Created instance {:?} for {}", instance, info.name);
            
            // Initialize the AudioUnit - required before getting properties like CocoaUI
            let status = AudioUnitInitialize(instance);
            println!("[AudioUnit] Initialize status: {} for {}", status, info.name);
            if status != noErr {
                AudioComponentInstanceDispose(instance);
                return Err(format!("Failed to initialize AudioUnit: OSStatus {}", status));
            }
            
            Ok(Self {
                unit: instance,
                info: info.clone(),
                enabled: true,
                instance_id,
            })
        }
    }
    
    /// Get the raw AudioUnit handle (for Cocoa UI)
    pub fn get_handle(&self) -> AudioComponentInstance {
        self.unit
    }
}

impl Drop for AudioUnitInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.unit.is_null() {
                // Uninitialize before disposing
                AudioUnitUninitialize(self.unit);
                AudioComponentInstanceDispose(self.unit);
            }
        }
    }
}

/// Manager for AudioUnit instances
pub struct AudioUnitManager {
    /// Instances by ID
    instances: RwLock<HashMap<String, Arc<RwLock<AudioUnitInstance>>>>,
    /// Counter for unique instance IDs
    counter: std::sync::atomic::AtomicU64,
}

impl AudioUnitManager {
    pub fn new() -> Self {
        Self {
            instances: RwLock::new(HashMap::new()),
            counter: std::sync::atomic::AtomicU64::new(1),
        }
    }
    
    /// Create a new AudioUnit instance
    pub fn create_instance(&self, info: &AudioUnitInfo) -> Result<String, String> {
        let id = self.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let instance_id = format!("au_{}", id);
        
        let instance = AudioUnitInstance::new(info, instance_id.clone())?;
        self.instances.write().insert(
            instance_id.clone(),
            Arc::new(RwLock::new(instance)),
        );
        
        Ok(instance_id)
    }
    
    /// Get an instance by ID
    pub fn get_instance(&self, id: &str) -> Option<Arc<RwLock<AudioUnitInstance>>> {
        self.instances.read().get(id).cloned()
    }
    
    /// Remove an instance
    pub fn remove_instance(&self, id: &str) -> bool {
        self.instances.write().remove(id).is_some()
    }
    
    /// Set enabled state
    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        if let Some(instance) = self.instances.read().get(id) {
            instance.write().enabled = enabled;
            true
        } else {
            false
        }
    }
    
    /// List all instances
    pub fn list_instances(&self) -> Vec<(String, AudioUnitInfo, bool)> {
        self.instances.read().iter()
            .map(|(id, inst)| {
                let inst = inst.read();
                (id.clone(), inst.info.clone(), inst.enabled)
            })
            .collect()
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
