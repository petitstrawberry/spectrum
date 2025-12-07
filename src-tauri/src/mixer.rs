//! Audio Mixer Engine
//! Uses Accelerate vDSP for hardware-accelerated mixing

use crate::vdsp::VDsp;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Maximum number of Prism channels (32 stereo pairs = 64 mono channels)
pub const PRISM_CHANNELS: usize = 64;
/// Maximum number of output devices
pub const MAX_OUTPUTS: usize = 16;
/// Maximum stereo pairs per output (e.g., 32 for a 64ch device)
pub const MAX_OUTPUT_PAIRS: usize = 32;
/// Maximum number of sends
pub const MAX_SENDS: usize = 1024;
/// Maximum number of buses
pub const MAX_BUSES: usize = 32;
/// Bus channels (stereo)
pub const BUS_CHANNELS: usize = 2;

/// A send connection from a source channel to an output device channel (1ch unit)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Send {
    /// Source device ID (0 = Prism, other = input device ID)
    pub source_device: u32,
    /// Source channel index (0-63 for Prism, or device channel index)
    pub source_channel: u32,
    /// Target output device ID
    pub target_device: String,
    /// Target channel index (0, 1, 2, ... for mono channels)
    pub target_channel: u32,
    /// Send level (0.0 to 1.0)
    pub level: f32,
    /// Muted
    pub muted: bool,
}

/// Source type for bus sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendSourceType {
    /// Source is a Prism/input device channel
    Input,
    /// Source is another bus
    Bus,
}

/// Target type for bus sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendTargetType {
    /// Target is a bus
    Bus,
    /// Target is an output device
    Output,
}

/// A send connection involving buses (for chaining)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusSend {
    /// Source type (Input or Bus)
    pub source_type: BusSendSourceType,
    /// Source ID (device_id for Input, bus_id string for Bus)
    pub source_id: String,
    /// Source device ID (only used when source_type is Input)
    pub source_device: u32,
    /// Source channel index
    pub source_channel: u32,
    /// Target type (Bus or Output)
    pub target_type: BusSendTargetType,
    /// Target ID (bus_id for Bus, device_id for Output)
    pub target_id: String,
    /// Target channel index
    pub target_channel: u32,
    /// Send level (0.0 to 1.0)
    pub level: f32,
    /// Muted
    pub muted: bool,
}

/// Compact bus send for audio callback
#[derive(Debug, Clone, Copy, Default)]
pub struct BusSendCompact {
    pub source_type: u8, // 0 = Input, 1 = Bus
    pub source_device: u32,
    pub source_channel: u32,
    pub source_bus_idx: u8, // Index into bus array (when source_type = Bus)
    pub target_type: u8, // 0 = Bus, 1 = Output
    pub target_bus_idx: u8, // Index into bus array (when target_type = Bus)
    pub target_device_hash: u64, // Hash of output device (when target_type = Output)
    pub target_channel: u32,
    pub level: f32,
    pub active: bool,
}

/// Bus definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bus {
    /// Bus identifier (e.g., "bus_1", "bus_2")
    pub id: String,
    /// Bus label/name
    pub label: String,
    /// Number of channels (typically 2 for stereo)
    pub channels: u32,
    /// Fader level (0.0 to 1.0)
    pub fader: f32,
    /// Muted
    pub muted: bool,
    /// Plugin chain (list of AudioUnit instance IDs in processing order)
    #[serde(default)]
    pub plugin_ids: Vec<String>,
}

impl Default for Bus {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            channels: 2,
            fader: 1.0,
            muted: false,
            plugin_ids: Vec::new(),
        }
    }
}

/// Bus buffer for audio processing with cache support
pub struct BusBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
    /// Sample counter when this buffer was last processed (0 = never/invalid)
    pub processed_at: u64,
    /// Number of valid frames in the buffer
    pub valid_frames: usize,
}

impl BusBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
            processed_at: 0,
            valid_frames: 0,
        }
    }

    pub fn clear(&mut self, frames: usize) {
        for i in 0..frames.min(MAX_FRAMES) {
            self.left[i] = 0.0;
            self.right[i] = 0.0;
        }
        self.valid_frames = frames;
    }
    
    /// Check if this buffer is valid for the given sample counter
    #[inline]
    pub fn is_valid(&self, sample_counter: u64) -> bool {
        self.processed_at == sample_counter && self.valid_frames > 0
    }
    
    /// Mark this buffer as processed at the given sample counter
    #[inline]
    pub fn mark_processed(&mut self, sample_counter: u64, frames: usize) {
        self.processed_at = sample_counter;
        self.valid_frames = frames;
    }
}

/// Global sample counter for cache invalidation
/// Incremented each audio cycle by the first device to process
pub struct SampleCounter {
    counter: AtomicU64,
}

impl SampleCounter {
    pub fn new() -> Self {
        Self {
            counter: AtomicU64::new(1), // Start at 1, 0 means "never processed"
        }
    }
    
    /// Get current sample counter value
    #[inline]
    pub fn get(&self) -> u64 {
        self.counter.load(Ordering::Acquire)
    }
    
    /// Try to increment the counter (only one device per cycle succeeds)
    /// Returns (new_counter, true) if we incremented, (current, false) if someone else did
    #[inline]
    pub fn try_increment(&self) -> (u64, bool) {
        let current = self.counter.load(Ordering::Acquire);
        match self.counter.compare_exchange(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Relaxed
        ) {
            Ok(_) => (current + 1, true),
            Err(actual) => (actual, false),
        }
    }
}

/// Bus processing state - tracks which buses have been processed this cycle
pub struct BusProcessingState {
    /// Global sample counter
    sample_counter: SampleCounter,
}

impl BusProcessingState {
    pub fn new() -> Self {
        Self {
            sample_counter: SampleCounter::new(),
        }
    }
    
    /// Get the current sample counter value
    #[inline]
    pub fn get_sample_counter(&self) -> u64 {
        self.sample_counter.get()
    }
    
    /// Try to advance the sample counter to the next cycle
    /// Returns (counter, true) if this device started a new cycle
    /// Returns (counter, false) if another device already started this cycle
    #[inline]
    pub fn next_cycle(&self) -> (u64, bool) {
        self.sample_counter.try_increment()
    }
}

/// Optimized send for audio callback (no String allocation)
#[derive(Debug, Clone, Copy, Default)]
pub struct SendCompact {
    pub source_device: u32,
    pub source_channel: u32,
    pub target_device_hash: u64,
    pub target_channel: u32,
    pub level: f32,
    pub active: bool, // true if not muted and level > 0
}

/// Level meters for a channel pair
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ChannelLevels {
    pub left_rms: f32,
    pub right_rms: f32,
    pub left_peak: f32,
    pub right_peak: f32,
}

/// Compact sends array for lock-free audio callback access
/// Uses double-buffering for lock-free reads in audio thread
pub struct SendsArray {
    /// Active sends (read by audio thread)
    sends: RwLock<Vec<SendCompact>>,
    /// Version counter for cache invalidation
    version: AtomicU64,
}

impl SendsArray {
    pub fn new() -> Self {
        Self {
            sends: RwLock::new(Vec::with_capacity(MAX_SENDS)),
            version: AtomicU64::new(0),
        }
    }

    /// Get current version
    #[inline]
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Read sends (for audio callback - fast path)
    #[inline]
    pub fn read(&self) -> parking_lot::RwLockReadGuard<'_, Vec<SendCompact>> {
        self.sends.read()
    }

    /// Try to read sends without blocking (for audio callback - non-blocking)
    #[inline]
    pub fn try_read(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<SendCompact>>> {
        self.sends.try_read()
    }

    /// Update sends from main thread
    pub fn update(&self, sends: &[Send], output_faders: &HashMap<String, f32>) {
        let mut compact = self.sends.write();
        compact.clear();
        
        for send in sends {
            if send.muted || send.level <= 0.0001 {
                continue;
            }
            
            let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
            let total_level = send.level * output_gain;
            
            if total_level <= 0.0001 {
                continue;
            }
            
            compact.push(SendCompact {
                source_device: send.source_device,
                source_channel: send.source_channel,
                target_device_hash: hash_device_id(&send.target_device),
                target_channel: send.target_channel,
                level: total_level,
                active: true,
            });
        }
        
        self.version.fetch_add(1, Ordering::Release);
    }
}

/// Bus sends array for audio callback
pub struct BusSendsArray {
    /// Bus definitions (index -> Bus)
    buses: RwLock<Vec<Bus>>,
    /// Bus ID to index mapping
    bus_id_to_idx: RwLock<HashMap<String, usize>>,
    /// Active bus sends (read by audio thread)
    sends: RwLock<Vec<BusSendCompact>>,
    /// Pre-computed processing order (Kahn's algorithm result)
    /// Contains bus indices in the order they should be processed
    processing_order: RwLock<Vec<u8>>,
    /// Version counter for cache invalidation
    version: AtomicU64,
}

impl BusSendsArray {
    pub fn new() -> Self {
        Self {
            buses: RwLock::new(Vec::with_capacity(MAX_BUSES)),
            bus_id_to_idx: RwLock::new(HashMap::new()),
            sends: RwLock::new(Vec::with_capacity(MAX_SENDS)),
            processing_order: RwLock::new(Vec::with_capacity(MAX_BUSES)),
            version: AtomicU64::new(0),
        }
    }

    /// Get current version
    #[inline]
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Read bus sends (for audio callback)
    #[inline]
    pub fn try_read_sends(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<BusSendCompact>>> {
        self.sends.try_read()
    }

    /// Read buses (for audio callback)
    #[inline]
    pub fn try_read_buses(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<Bus>>> {
        self.buses.try_read()
    }
    
    /// Read pre-computed processing order (for audio callback)
    #[inline]
    pub fn try_read_order(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<u8>>> {
        self.processing_order.try_read()
    }

    /// Get bus count
    pub fn bus_count(&self) -> usize {
        self.buses.read().len()
    }

    /// Get bus index by ID
    pub fn get_bus_index(&self, bus_id: &str) -> Option<usize> {
        self.bus_id_to_idx.read().get(bus_id).copied()
    }

    /// Add a bus
    pub fn add_bus(&self, bus: Bus) {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();
        
        // Check if bus already exists
        if id_map.contains_key(&bus.id) {
            return;
        }
        
        let idx = buses.len();
        id_map.insert(bus.id.clone(), idx);
        buses.push(bus);
        
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();
        let mut sends = self.sends.write();
        
        if let Some(idx) = id_map.remove(bus_id) {
            buses.remove(idx);
            
            // Update indices for remaining buses
            for (id, old_idx) in id_map.iter_mut() {
                if *old_idx > idx {
                    *old_idx -= 1;
                }
            }
            
            // Remove sends involving this bus and update indices
            sends.retain(|send| {
                let source_ok = send.source_type != 1 || send.source_bus_idx as usize != idx;
                let target_ok = send.target_type != 0 || send.target_bus_idx as usize != idx;
                source_ok && target_ok
            });
            
            // Update bus indices in remaining sends
            for send in sends.iter_mut() {
                if send.source_type == 1 && send.source_bus_idx as usize > idx {
                    send.source_bus_idx -= 1;
                }
                if send.target_type == 0 && send.target_bus_idx as usize > idx {
                    send.target_bus_idx -= 1;
                }
            }
            
            // Recompute processing order
            self.compute_processing_order(&sends, buses.len());
        }
        
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                bus.fader = level;
            }
        }
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                bus.muted = muted;
            }
        }
        self.version.fetch_add(1, Ordering::Release);
    }
    
    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                println!("[Mixer] Set bus {} plugins: {:?}", bus_id, plugin_ids);
                bus.plugin_ids = plugin_ids;
            }
        }
        self.version.fetch_add(1, Ordering::Release);
    }
    
    /// Get bus plugin chain
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let buses = self.buses.read();
            if let Some(bus) = buses.get(idx) {
                return bus.plugin_ids.clone();
            }
        }
        Vec::new()
    }
    
    /// Get bus plugin chain by index (for audio callback)
    pub fn get_bus_plugins_by_idx(&self, bus_idx: usize) -> Vec<String> {
        let buses = self.buses.read();
        if let Some(bus) = buses.get(bus_idx) {
            return bus.plugin_ids.clone();
        }
        Vec::new()
    }

    /// Update bus sends from main thread
    pub fn update_sends(&self, bus_sends: &[BusSend], output_faders: &HashMap<String, f32>) {
        let id_map = self.bus_id_to_idx.read();
        let buses = self.buses.read();
        let mut compact = self.sends.write();
        compact.clear();
        
        for send in bus_sends {
            if send.muted || send.level <= 0.0001 {
                continue;
            }
            
            // Resolve source
            let (source_type, source_bus_idx) = match send.source_type {
                BusSendSourceType::Input => (0u8, 0u8),
                BusSendSourceType::Bus => {
                    if let Some(&idx) = id_map.get(&send.source_id) {
                        // Check if source bus is muted
                        if let Some(bus) = buses.get(idx) {
                            if bus.muted {
                                continue;
                            }
                        }
                        (1u8, idx as u8)
                    } else {
                        continue; // Unknown bus
                    }
                }
            };
            
            // Resolve target
            let (target_type, target_bus_idx, target_device_hash) = match send.target_type {
                BusSendTargetType::Bus => {
                    if let Some(&idx) = id_map.get(&send.target_id) {
                        (0u8, idx as u8, 0u64)
                    } else {
                        continue; // Unknown bus
                    }
                }
                BusSendTargetType::Output => {
                    let output_gain = output_faders.get(&send.target_id).copied().unwrap_or(1.0);
                    if output_gain <= 0.0001 {
                        continue;
                    }
                    (1u8, 0u8, hash_device_id(&send.target_id))
                }
            };
            
            compact.push(BusSendCompact {
                source_type,
                source_device: send.source_device,
                source_channel: send.source_channel,
                source_bus_idx,
                target_type,
                target_bus_idx,
                target_device_hash,
                target_channel: send.target_channel,
                level: send.level,
                active: true,
            });
        }
        
        // Compute topological order using Kahn's algorithm
        let bus_count = buses.len();
        println!("[Mixer] update_sends complete, computing order for {} buses, {} sends", bus_count, compact.len());
        self.compute_processing_order(&compact, bus_count);
        
        self.version.fetch_add(1, Ordering::Release);
    }
    
    /// Compute processing order using Kahn's algorithm
    /// This determines the order in which buses should be processed
    fn compute_processing_order(&self, sends: &[BusSendCompact], bus_count: usize) {
        let mut order = self.processing_order.write();
        order.clear();
        
        if bus_count == 0 {
            return;
        }
        
        // Step 1: Count in-degrees for each bus (how many buses feed into it)
        let mut in_degree = vec![0u8; bus_count];
        
        for send in sends.iter() {
            // Only count Bus -> Bus sends
            if send.active && send.source_type == 1 && send.target_type == 0 {
                let target_idx = send.target_bus_idx as usize;
                if target_idx < bus_count {
                    in_degree[target_idx] = in_degree[target_idx].saturating_add(1);
                }
            }
        }
        
        // Step 2: Initialize queue with buses that have in-degree 0
        let mut queue: Vec<u8> = Vec::with_capacity(bus_count);
        for (idx, &deg) in in_degree.iter().enumerate() {
            if deg == 0 {
                queue.push(idx as u8);
            }
        }
        
        // Step 3: Process the queue (Kahn's algorithm)
        let mut head = 0;
        while head < queue.len() {
            let current = queue[head] as usize;
            head += 1;
            
            order.push(current as u8);
            
            // Decrease in-degree for all buses this one feeds into
            for send in sends.iter() {
                if send.active && send.source_type == 1 && send.target_type == 0 
                    && send.source_bus_idx as usize == current 
                {
                    let target_idx = send.target_bus_idx as usize;
                    if target_idx < bus_count {
                        in_degree[target_idx] = in_degree[target_idx].saturating_sub(1);
                        if in_degree[target_idx] == 0 {
                            queue.push(target_idx as u8);
                        }
                    }
                }
            }
        }
        
        // Check for cycles (if not all buses are in the order, there's a cycle)
        if order.len() != bus_count {
            println!("[Mixer] Warning: Cycle detected in bus routing! Adding remaining buses at end.");
            for idx in 0..bus_count {
                if !order.contains(&(idx as u8)) {
                    order.push(idx as u8);
                }
            }
        }
        
        println!("[Mixer] Computed bus processing order: {:?}", order.as_slice());
    }

    /// Add or update a bus send
    pub fn set_bus_send(&self, send: BusSend) {
        let id_map = self.bus_id_to_idx.read();
        let buses = self.buses.read();
        
        // Resolve indices
        let source_bus_idx = match send.source_type {
            BusSendSourceType::Bus => id_map.get(&send.source_id).copied(),
            _ => Some(0),
        };
        let target_bus_idx = match send.target_type {
            BusSendTargetType::Bus => id_map.get(&send.target_id).copied(),
            _ => Some(0),
        };
        
        if source_bus_idx.is_none() || target_bus_idx.is_none() {
            println!("[Mixer] Bus send references unknown bus: source_id={}, target_id={}", send.source_id, send.target_id);
            return;
        }
        
        // Check source bus mute
        if send.source_type == BusSendSourceType::Bus {
            if let Some(idx) = source_bus_idx {
                if let Some(bus) = buses.get(idx) {
                    if bus.muted {
                        return;
                    }
                }
            }
        }
        
        let target_device_hash = match send.target_type {
            BusSendTargetType::Output => hash_device_id(&send.target_id),
            _ => 0,
        };
        
        let compact_send = BusSendCompact {
            source_type: match send.source_type {
                BusSendSourceType::Input => 0,
                BusSendSourceType::Bus => 1,
            },
            source_device: send.source_device,
            source_channel: send.source_channel,
            source_bus_idx: source_bus_idx.unwrap_or(0) as u8,
            target_type: match send.target_type {
                BusSendTargetType::Bus => 0,
                BusSendTargetType::Output => 1,
            },
            target_bus_idx: target_bus_idx.unwrap_or(0) as u8,
            target_device_hash,
            target_channel: send.target_channel,
            level: send.level,
            active: !send.muted && send.level > 0.0001,
        };
        
        let mut sends = self.sends.write();
        
        // Find existing send with same source and target
        if let Some(existing) = sends.iter_mut().find(|s| {
            s.source_type == compact_send.source_type
                && s.source_device == compact_send.source_device
                && s.source_channel == compact_send.source_channel
                && s.source_bus_idx == compact_send.source_bus_idx
                && s.target_type == compact_send.target_type
                && s.target_bus_idx == compact_send.target_bus_idx
                && s.target_device_hash == compact_send.target_device_hash
                && s.target_channel == compact_send.target_channel
        }) {
            existing.level = compact_send.level;
            existing.active = compact_send.active;
        } else {
            sends.push(compact_send);
        }
        
        // Recompute processing order
        let bus_count = buses.len();
        self.compute_processing_order(&sends, bus_count);
        
        drop(sends);
        drop(buses);
        drop(id_map);
        
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Remove a bus send
    pub fn remove_bus_send(
        &self,
        source_type: BusSendSourceType,
        source_id: &str,
        source_device: u32,
        source_channel: u32,
        target_type: BusSendTargetType,
        target_id: &str,
        target_channel: u32,
    ) {
        let id_map = self.bus_id_to_idx.read();
        
        let source_bus_idx = match source_type {
            BusSendSourceType::Bus => id_map.get(source_id).copied().unwrap_or(255) as u8,
            _ => 0,
        };
        let target_bus_idx = match target_type {
            BusSendTargetType::Bus => id_map.get(target_id).copied().unwrap_or(255) as u8,
            _ => 0,
        };
        let target_device_hash = match target_type {
            BusSendTargetType::Output => hash_device_id(target_id),
            _ => 0,
        };
        
        let src_type = match source_type {
            BusSendSourceType::Input => 0u8,
            BusSendSourceType::Bus => 1u8,
        };
        let tgt_type = match target_type {
            BusSendTargetType::Bus => 0u8,
            BusSendTargetType::Output => 1u8,
        };
        
        let mut sends = self.sends.write();
        sends.retain(|s| {
            !(s.source_type == src_type
                && s.source_device == source_device
                && s.source_channel == source_channel
                && s.source_bus_idx == source_bus_idx
                && s.target_type == tgt_type
                && s.target_bus_idx == target_bus_idx
                && s.target_device_hash == target_device_hash
                && s.target_channel == target_channel)
        });
        
        // Recompute processing order
        let buses = self.buses.read();
        self.compute_processing_order(&sends, buses.len());
        
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Get all buses
    pub fn get_buses(&self) -> Vec<Bus> {
        self.buses.read().clone()
    }

    /// Get all bus sends
    pub fn get_bus_sends_compact(&self) -> Vec<BusSendCompact> {
        self.sends.read().clone()
    }
}

/// Fast hash for device ID string (for audio callback comparison)
#[inline]
pub fn hash_device_id(device_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    device_id.hash(&mut hasher);
    hasher.finish()
}

/// Maximum frames per buffer
pub const MAX_FRAMES: usize = 4096;

/// Pre-allocated buffer for one source pair (stereo)
pub struct PairBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
}

impl PairBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
        }
    }
}

/// Buffer pool for an output device
/// Grows dynamically when new source pairs are routed to this device
pub struct OutputBufferPool {
    /// Buffers indexed by cache slot
    buffers: Vec<PairBuffer>,
    /// Map from (source_device, pair_idx) to buffer index
    pair_to_buffer: HashMap<(u32, usize), usize>,
}

impl OutputBufferPool {
    pub fn new() -> Self {
        Self {
            buffers: Vec::new(),
            pair_to_buffer: HashMap::new(),
        }
    }

    /// Get or allocate buffer for a source pair
    /// Returns buffer index
    pub fn get_or_allocate(&mut self, source_device: u32, pair_idx: usize) -> usize {
        let key = (source_device, pair_idx);
        if let Some(&idx) = self.pair_to_buffer.get(&key) {
            return idx;
        }
        // Allocate new buffer
        let idx = self.buffers.len();
        self.buffers.push(PairBuffer::new());
        self.pair_to_buffer.insert(key, idx);
        idx
    }

    /// Get buffer by index (for audio callback)
    #[inline]
    pub fn get_buffer(&self, idx: usize) -> Option<&PairBuffer> {
        self.buffers.get(idx)
    }

    /// Get mutable buffer by index (for audio callback)
    #[inline]
    pub fn get_buffer_mut(&mut self, idx: usize) -> Option<&mut PairBuffer> {
        self.buffers.get_mut(idx)
    }

    /// Find buffer index for a source pair (for audio callback - no allocation)
    #[inline]
    pub fn find_buffer(&self, source_device: u32, pair_idx: usize) -> Option<usize> {
        self.pair_to_buffer.get(&(source_device, pair_idx)).copied()
    }

    /// Number of allocated buffers
    pub fn len(&self) -> usize {
        self.buffers.len()
    }
}

/// Global buffer pools for each output device
static OUTPUT_BUFFER_POOLS: std::sync::LazyLock<RwLock<HashMap<u64, Arc<RwLock<OutputBufferPool>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Get or create buffer pool for an output device
pub fn get_output_buffer_pool(device_id: u64) -> Arc<RwLock<OutputBufferPool>> {
    // Try read first
    {
        let pools = OUTPUT_BUFFER_POOLS.read();
        if let Some(pool) = pools.get(&device_id) {
            return Arc::clone(pool);
        }
    }
    // Create new pool
    let mut pools = OUTPUT_BUFFER_POOLS.write();
    pools.entry(device_id)
        .or_insert_with(|| Arc::new(RwLock::new(OutputBufferPool::new())))
        .clone()
}

/// Pre-allocate buffers for an output device based on sends
/// Call this when routing changes
pub fn allocate_buffers_for_output(device_id: u64, device_id_str: &str, sends: &[Send]) {
    let pool = get_output_buffer_pool(device_id);
    let mut pool = pool.write();
    let target_hash = hash_device_id(device_id_str);
    
    // Find all unique source pairs targeting this device
    for send in sends {
        if send.muted {
            continue;
        }
        let send_target_hash = hash_device_id(&send.target_device);
        if send_target_hash != target_hash {
            continue;
        }
        let pair_idx = send.source_channel as usize / 2;
        pool.get_or_allocate(send.source_device, pair_idx);
    }
}

/// Global mixer state shared between audio thread and UI
pub struct MixerState {
    /// Send connections (source -> target mappings) - for UI
    pub sends: RwLock<Vec<Send>>,
    /// Compact sends for audio callback (lock-free read)
    pub sends_compact: SendsArray,
    /// Bus sends for routing via buses
    pub bus_sends: BusSendsArray,
    /// Bus buffers for audio processing (indexed by bus index)
    pub bus_buffers: RwLock<Vec<BusBuffer>>,
    /// Bus processing state - ensures buses are processed exactly once per audio cycle
    pub bus_processing: BusProcessingState,
    /// Master fader for each Prism channel pair (0.0 to 1.0)
    pub source_faders: RwLock<[f32; PRISM_CHANNELS / 2]>,
    /// Mute state for each source channel pair
    pub source_mutes: RwLock<[bool; PRISM_CHANNELS / 2]>,
    /// Master fader for each output device (device_id -> level)
    pub output_faders: RwLock<HashMap<String, f32>>,
    /// Current input levels (from Prism)
    pub input_levels: RwLock<[ChannelLevels; PRISM_CHANNELS / 2]>,
    /// Current output levels (per device per pair)
    pub output_levels: RwLock<HashMap<String, Vec<ChannelLevels>>>,
    /// Bus levels (post-plugin, post-fader) - indexed by bus index
    pub bus_levels: RwLock<[ChannelLevels; MAX_BUSES]>,
    /// Sample rate
    pub sample_rate: RwLock<u32>,
    /// Buffer size
    pub buffer_size: RwLock<u32>,
}

impl Default for MixerState {
    fn default() -> Self {
        Self::new()
    }
}

impl MixerState {
    pub fn new() -> Self {
        Self {
            sends: RwLock::new(Vec::new()),
            sends_compact: SendsArray::new(),
            bus_sends: BusSendsArray::new(),
            bus_buffers: RwLock::new(Vec::new()),
            bus_processing: BusProcessingState::new(),
            source_faders: RwLock::new([1.0; PRISM_CHANNELS / 2]),
            source_mutes: RwLock::new([false; PRISM_CHANNELS / 2]),
            output_faders: RwLock::new(HashMap::new()),
            input_levels: RwLock::new([ChannelLevels::default(); PRISM_CHANNELS / 2]),
            output_levels: RwLock::new(HashMap::new()),
            bus_levels: RwLock::new([ChannelLevels::default(); MAX_BUSES]),
            sample_rate: RwLock::new(48000),
            buffer_size: RwLock::new(128),
        }
    }

    /// Rebuild compact sends array (call after any send/fader change)
    fn rebuild_compact_sends(&self) {
        let sends = self.sends.read();
        let output_faders = self.output_faders.read();
        self.sends_compact.update(&sends, &output_faders);
        
        // Pre-allocate buffers for all output devices
        // Collect unique target devices first
        use std::collections::HashSet;
        let mut target_devices: HashSet<(u64, String)> = HashSet::new();
        for send in sends.iter() {
            if !send.muted && send.level > 0.0001 {
                target_devices.insert((hash_device_id(&send.target_device), send.target_device.clone()));
            }
        }
        
        // Allocate buffers for each target device
        for (device_hash, device_id) in target_devices {
            allocate_buffers_for_output(device_hash, &device_id, &sends);
        }
    }

    /// Add or update a send (1ch unit)
    pub fn set_send(&self, send: Send) {
        {
            let mut sends = self.sends.write();
            // Find existing send with same source device/channel and target device/channel
            if let Some(existing) = sends.iter_mut().find(|s| {
                s.source_device == send.source_device
                    && s.source_channel == send.source_channel
                    && s.target_device == send.target_device
                    && s.target_channel == send.target_channel
            }) {
                println!("[Mixer] Updated send: src_dev={} src_ch={} -> dev={} tgt_ch={} level={} muted={}", 
                    send.source_device, send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
                existing.level = send.level;
                existing.muted = send.muted;
            } else {
                println!("[Mixer] New send: src_dev={} src_ch={} -> dev={} tgt_ch={} level={} muted={}", 
                    send.source_device, send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
                sends.push(send);
            }
            println!("[Mixer] Total sends: {}", sends.len());
        }
        // Rebuild compact sends for audio callback
        self.rebuild_compact_sends();
    }

    /// Remove a send (1ch unit)
    pub fn remove_send(&self, source_device: u32, source_channel: u32, target_device: &str, target_channel: u32) {
        {
            let mut sends = self.sends.write();
            sends.retain(|s| {
                !(s.source_device == source_device
                    && s.source_channel == source_channel
                    && s.target_device == target_device
                    && s.target_channel == target_channel)
            });
        }
        self.rebuild_compact_sends();
    }

    /// Set source fader level (0-100 -> 0.0-1.0)
    pub fn set_source_fader(&self, pair_index: usize, level: f32) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_faders.write()[pair_index] = (level / 100.0).clamp(0.0, 1.0);
        }
    }

    /// Set source mute
    pub fn set_source_mute(&self, pair_index: usize, muted: bool) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_mutes.write()[pair_index] = muted;
        }
    }

    /// Set output master fader (dB value: -inf to +6)
    pub fn set_output_fader(&self, device_id: &str, db: f32) {
        // Convert dB to linear gain
        let gain = if db <= -100.0 {
            0.0
        } else {
            10.0_f32.powf(db / 20.0).clamp(0.0, 2.0) // +6dB = ~2.0 linear
        };
        {
            self.output_faders
                .write()
                .insert(device_id.to_string(), gain);
        }
        // Rebuild compact sends to include new fader value
        self.rebuild_compact_sends();
    }

    /// Get all sends
    pub fn get_sends(&self) -> Vec<Send> {
        self.sends.read().clone()
    }

    /// Get input levels
    pub fn get_input_levels(&self) -> [ChannelLevels; PRISM_CHANNELS / 2] {
        *self.input_levels.read()
    }

    /// Get output levels for a device
    pub fn get_output_levels(&self, device_id: &str) -> Vec<ChannelLevels> {
        self.output_levels
            .read()
            .get(device_id)
            .cloned()
            .unwrap_or_default()
    }

    // ========== Bus Operations ==========

    /// Add a bus
    pub fn add_bus(&self, id: String, label: String, channels: u32) {
        let bus = Bus {
            id: id.clone(),
            label,
            channels,
            fader: 1.0,
            muted: false,
            plugin_ids: Vec::new(),
        };
        self.bus_sends.add_bus(bus);
        
        // Add bus buffer
        let mut buffers = self.bus_buffers.write();
        buffers.push(BusBuffer::new());
        
        println!("[Mixer] Added bus: {}", id);
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        if let Some(idx) = self.bus_sends.get_bus_index(bus_id) {
            self.bus_sends.remove_bus(bus_id);
            
            // Remove bus buffer
            let mut buffers = self.bus_buffers.write();
            if idx < buffers.len() {
                buffers.remove(idx);
            }
            
            println!("[Mixer] Removed bus: {}", bus_id);
        }
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        self.bus_sends.set_bus_fader(bus_id, level.clamp(0.0, 1.0));
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        self.bus_sends.set_bus_mute(bus_id, muted);
    }
    
    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        self.bus_sends.set_bus_plugins(bus_id, plugin_ids);
    }
    
    /// Get bus plugin chain
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        self.bus_sends.get_bus_plugins(bus_id)
    }

    /// Add or update a bus send (Input/Bus -> Bus/Output)
    pub fn set_bus_send(&self, send: BusSend) {
        println!("[Mixer] Bus send: {:?} {} ch{} -> {:?} {} ch{} level={}",
            send.source_type, send.source_id, send.source_channel,
            send.target_type, send.target_id, send.target_channel, send.level);
        self.bus_sends.set_bus_send(send);
    }

    /// Remove a bus send
    pub fn remove_bus_send(
        &self,
        source_type: BusSendSourceType,
        source_id: &str,
        source_device: u32,
        source_channel: u32,
        target_type: BusSendTargetType,
        target_id: &str,
        target_channel: u32,
    ) {
        self.bus_sends.remove_bus_send(
            source_type, source_id, source_device, source_channel,
            target_type, target_id, target_channel,
        );
    }

    /// Get all buses
    pub fn get_buses(&self) -> Vec<Bus> {
        self.bus_sends.get_buses()
    }

    /// Get bus sends for debugging
    pub fn get_bus_sends(&self) -> Vec<BusSendCompact> {
        self.bus_sends.get_bus_sends_compact()
    }
    
    /// Update bus levels (called from audio callback after plugin processing)
    pub fn update_bus_level(&self, bus_idx: usize, left_rms: f32, right_rms: f32, left_peak: f32, right_peak: f32) {
        if let Some(mut levels) = self.bus_levels.try_write() {
            if bus_idx < MAX_BUSES {
                levels[bus_idx] = ChannelLevels {
                    left_rms,
                    right_rms,
                    left_peak,
                    right_peak,
                };
            }
        }
    }
    
    /// Get bus levels (for UI)
    pub fn get_bus_levels(&self) -> Vec<(String, ChannelLevels)> {
        let buses = self.bus_sends.get_buses();
        let levels = self.bus_levels.read();
        
        buses.iter().enumerate()
            .map(|(idx, bus)| {
                let level = if idx < MAX_BUSES {
                    levels[idx]
                } else {
                    ChannelLevels::default()
                };
                (bus.id.clone(), level)
            })
            .collect()
    }
}

/// Audio processing buffer for mixing
pub struct MixBuffer {
    /// Stereo interleaved buffer
    pub data: Vec<f32>,
    /// Number of frames
    pub frames: usize,
}

impl MixBuffer {
    pub fn new(frames: usize) -> Self {
        Self {
            data: vec![0.0; frames * 2],
            frames,
        }
    }

    pub fn clear(&mut self) {
        VDsp::clear(&mut self.data);
    }

    pub fn left(&self) -> impl Iterator<Item = f32> + '_ {
        self.data.iter().step_by(2).copied()
    }

    pub fn right(&self) -> impl Iterator<Item = f32> + '_ {
        self.data.iter().skip(1).step_by(2).copied()
    }

    pub fn left_slice(&self) -> Vec<f32> {
        self.left().collect()
    }

    pub fn right_slice(&self) -> Vec<f32> {
        self.right().collect()
    }
}

/// Process audio mixing for one buffer (1ch unit)
///
/// This is called from the audio callback and performs the actual mixing
/// using Accelerate vDSP for hardware acceleration.
pub fn process_mix(
    input_channels: &[&[f32]; PRISM_CHANNELS],
    output_buffers: &mut HashMap<String, Vec<f32>>,
    state: &MixerState,
    frames: usize,
) {
    let sends = state.sends.read();
    let faders = *state.source_faders.read();
    let mutes = *state.source_mutes.read();
    let output_faders = state.output_faders.read();

    // Clear all output buffers
    for buf in output_buffers.values_mut() {
        VDsp::clear(buf);
    }

    // Process each send (1ch unit)
    for send in sends.iter() {
        if send.muted {
            continue;
        }

        let source_ch = send.source_channel as usize;
        if source_ch >= PRISM_CHANNELS {
            continue;
        }

        // Check if source pair is muted (still use pair-based mute for compatibility)
        let pair_index = source_ch / 2;
        if mutes[pair_index] {
            continue;
        }

        let input = input_channels[source_ch];

        // Calculate combined gain
        let source_gain = faders[pair_index];
        let send_gain = send.level;
        let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
        let total_gain = source_gain * send_gain * output_gain;

        if total_gain < 0.0001 {
            continue;
        }

        // Get output buffer and mix to target channel
        if let Some(output_buf) = output_buffers.get_mut(&send.target_device) {
            let target_ch = send.target_channel as usize;
            let output_channels = output_buf.len() / frames;

            if target_ch < output_channels {
                let offset = target_ch * frames;
                let out = &mut output_buf[offset..offset + frames];
                VDsp::mix_add(input, total_gain, out);
            }
        }
    }
}

/// Calculate levels for input channels
pub fn calculate_input_levels(
    input_channels: &[&[f32]; PRISM_CHANNELS],
    state: &MixerState,
) {
    let mut levels = state.input_levels.write();

    for pair in 0..(PRISM_CHANNELS / 2) {
        let left_ch = pair * 2;
        let right_ch = left_ch + 1;

        levels[pair] = ChannelLevels {
            left_rms: VDsp::rms(input_channels[left_ch]),
            right_rms: VDsp::rms(input_channels[right_ch]),
            left_peak: VDsp::peak(input_channels[left_ch]),
            right_peak: VDsp::peak(input_channels[right_ch]),
        };
    }
}

/// Calculate levels for output buffers
pub fn calculate_output_levels(
    output_buffers: &HashMap<String, Vec<f32>>,
    state: &MixerState,
    frames: usize,
) {
    let mut output_levels = state.output_levels.write();

    for (device_id, buffer) in output_buffers {
        let channels = buffer.len() / frames;
        let pairs = channels / 2;
        let mut levels = Vec::with_capacity(pairs);

        for pair in 0..pairs {
            let left_offset = pair * 2 * frames;
            let right_offset = (pair * 2 + 1) * frames;

            if right_offset + frames <= buffer.len() {
                let left = &buffer[left_offset..left_offset + frames];
                let right = &buffer[right_offset..right_offset + frames];

                levels.push(ChannelLevels {
                    left_rms: VDsp::rms(left),
                    right_rms: VDsp::rms(right),
                    left_peak: VDsp::peak(left),
                    right_peak: VDsp::peak(right),
                });
            }
        }

        output_levels.insert(device_id.clone(), levels);
    }
}

// Global mixer state (singleton)
lazy_static::lazy_static! {
    pub static ref MIXER_STATE: Arc<MixerState> = Arc::new(MixerState::new());
}

/// Get global mixer state
pub fn get_mixer_state() -> Arc<MixerState> {
    Arc::clone(&MIXER_STATE)
}
