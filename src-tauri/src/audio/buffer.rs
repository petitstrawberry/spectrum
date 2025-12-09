//! Audio Buffer implementation

use crate::vdsp::VDsp;
use super::MAX_FRAMES;

/// モノラルオーディオバッファ
pub struct AudioBuffer {
    data: Box<[f32; MAX_FRAMES]>,
    valid_frames: usize,
    /// Cached peak level (updated during process)
    peak: f32,
    /// Cached RMS level (updated during process)
    rms: f32,
}

impl AudioBuffer {
    pub fn new() -> Self {
        Self {
            data: Box::new([0.0; MAX_FRAMES]),
            valid_frames: 0,
            peak: 0.0,
            rms: 0.0,
        }
    }

    /// Clear the buffer (fill with zeros)
    pub fn clear(&mut self, frames: usize) {
        let frames = frames.min(MAX_FRAMES);
        VDsp::clear(&mut self.data[..frames]);
        self.valid_frames = frames;
        self.peak = 0.0;
        self.rms = 0.0;
    }

    /// Get the number of valid frames
    pub fn valid_frames(&self) -> usize {
        self.valid_frames
    }

    /// Set the number of valid frames
    pub fn set_valid_frames(&mut self, frames: usize) {
        self.valid_frames = frames.min(MAX_FRAMES);
    }

    /// Get samples as a slice
    pub fn samples(&self) -> &[f32] {
        &self.data[..self.valid_frames]
    }

    /// Get samples as a mutable slice
    pub fn samples_mut(&mut self) -> &mut [f32] {
        &mut self.data[..self.valid_frames]
    }

    /// Mix from another buffer with gain: self += source * gain
    pub fn mix_from(&mut self, source: &AudioBuffer, gain: f32) {
        let frames = self.valid_frames.min(source.valid_frames);
        if frames > 0 && gain.abs() > 0.0001 {
            VDsp::mix_add(&source.data[..frames], gain, &mut self.data[..frames]);
        }
    }

    /// Copy from another buffer
    pub fn copy_from(&mut self, source: &AudioBuffer) {
        let frames = self.valid_frames.min(source.valid_frames);
        self.data[..frames].copy_from_slice(&source.data[..frames]);
    }

    /// Apply gain in-place
    pub fn apply_gain(&mut self, gain: f32) {
        VDsp::apply_gain(&mut self.data[..self.valid_frames], gain);
    }

    /// Get peak level (updates cache)
    pub fn peak(&mut self) -> f32 {
        self.peak = VDsp::peak(&self.data[..self.valid_frames]);
        self.peak
    }

    /// Get cached peak level without recalculating
    pub fn cached_peak(&self) -> f32 {
        self.peak
    }

    /// Update peak cache
    pub fn update_peak(&mut self) {
        self.peak = VDsp::peak(&self.data[..self.valid_frames]);
    }

    /// Get RMS level (updates cache)
    pub fn rms(&mut self) -> f32 {
        self.rms = VDsp::rms(&self.data[..self.valid_frames]);
        self.rms
    }

    /// Get cached RMS level without recalculating
    pub fn cached_rms(&self) -> f32 {
        self.rms
    }

    /// Update both peak and RMS caches
    pub fn update_meters(&mut self) {
        let samples = &self.data[..self.valid_frames];
        self.peak = VDsp::peak(samples);
        self.rms = VDsp::rms(samples);
    }

    /// Write raw samples directly into the buffer
    pub fn write_samples(&mut self, samples: &[f32]) {
        let frames = samples.len().min(MAX_FRAMES);
        self.data[..frames].copy_from_slice(&samples[..frames]);
        self.valid_frames = frames;
    }
}

impl Default for AudioBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for AudioBuffer {
    fn clone(&self) -> Self {
        let mut new = Self::new();
        new.data.copy_from_slice(&*self.data);
        new.valid_frames = self.valid_frames;
        new.peak = self.peak;
        new.rms = self.rms;
        new
    }
}
