//! Ring Buffer for audio capture
//!
//! Lock-free SPSC ring buffer for audio data transfer between threads

use std::sync::atomic::{AtomicUsize, Ordering};

/// Ring buffer size per channel (fixed, large enough to prevent underrun)
/// 16384 frames at 48kHz = ~341ms buffer
pub const RING_BUFFER_SIZE: usize = 16384;

/// Circular buffer for one audio channel
pub struct RingBuffer {
    data: Box<[f32]>,
    write_pos: AtomicUsize,
    size: usize,
}

impl RingBuffer {
    /// Create a new ring buffer with the specified size
    pub fn new(size: usize) -> Self {
        Self {
            data: vec![0.0f32; size].into_boxed_slice(),
            write_pos: AtomicUsize::new(0),
            size,
        }
    }

    /// Create a new ring buffer with default size
    pub fn with_default_size() -> Self {
        Self::new(RING_BUFFER_SIZE)
    }

    /// Write samples to the buffer (called from input callback)
    ///
    /// # Safety
    /// This should only be called from a single writer thread.
    pub fn write(&self, samples: &[f32]) {
        let mut pos = self.write_pos.load(Ordering::Acquire);

        // Safety: single writer (input callback), multiple readers
        let data_ptr = self.data.as_ptr() as *mut f32;

        for &sample in samples {
            unsafe {
                *data_ptr.add(pos) = sample;
            }
            pos = (pos + 1) % self.size;
        }

        self.write_pos.store(pos, Ordering::Release);
    }

    /// Read samples from the buffer starting at a specific position
    /// Returns the new read position
    pub fn read(&self, read_pos: usize, out: &mut [f32]) -> usize {
        let write_pos = self.write_pos.load(Ordering::Acquire);

        // Normalize read_pos to be within buffer bounds
        let read_pos = read_pos % self.size;

        // Calculate available samples
        let available = if write_pos >= read_pos {
            write_pos - read_pos
        } else {
            self.size - read_pos + write_pos
        };

        let to_read = out.len().min(available);
        let mut pos = read_pos;

        for i in 0..to_read {
            out[i] = self.data[pos];
            pos = (pos + 1) % self.size;
        }

        // Fill remaining with silence if not enough samples
        for i in to_read..out.len() {
            out[i] = 0.0;
        }

        pos
    }

    /// Get current write position
    pub fn write_position(&self) -> usize {
        self.write_pos.load(Ordering::Acquire)
    }

    /// Get buffer size
    pub fn size(&self) -> usize {
        self.size
    }
}

/// Read positions for one output device (lock-free)
pub struct ReadPositions {
    positions: Vec<AtomicUsize>,
}

impl ReadPositions {
    /// Create new read positions for the specified number of channels
    pub fn new(num_channels: usize) -> Self {
        Self {
            positions: (0..num_channels).map(|_| AtomicUsize::new(0)).collect(),
        }
    }

    /// Create new read positions starting at specific positions
    pub fn at_positions(write_positions: &[usize]) -> Self {
        Self {
            positions: write_positions
                .iter()
                .map(|&pos| AtomicUsize::new(pos))
                .collect(),
        }
    }

    /// Get read position for a channel
    #[inline]
    pub fn get(&self, channel: usize) -> usize {
        if channel < self.positions.len() {
            self.positions[channel].load(Ordering::Acquire)
        } else {
            0
        }
    }

    /// Set read position for a channel
    #[inline]
    pub fn set(&self, channel: usize, pos: usize) {
        if channel < self.positions.len() {
            self.positions[channel].store(pos, Ordering::Release);
        }
    }

    /// Number of channels
    pub fn channel_count(&self) -> usize {
        self.positions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ring_buffer_write_read() {
        let buffer = RingBuffer::new(1024);

        // Write some samples
        let samples: Vec<f32> = (0..256).map(|i| i as f32 / 256.0).collect();
        buffer.write(&samples);

        // Read them back
        let mut output = vec![0.0f32; 256];
        let new_pos = buffer.read(0, &mut output);

        assert_eq!(new_pos, 256);
        assert_eq!(output[0], 0.0);
        assert!((output[255] - 255.0 / 256.0).abs() < 0.0001);
    }

    #[test]
    fn test_ring_buffer_wraparound() {
        let buffer = RingBuffer::new(100);

        // Write more than buffer size
        let samples: Vec<f32> = (0..150).map(|i| i as f32).collect();
        buffer.write(&samples);

        // Write position should have wrapped
        assert_eq!(buffer.write_position(), 50);
    }
}
