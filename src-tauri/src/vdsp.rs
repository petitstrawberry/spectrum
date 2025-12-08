//! vDSP bindings for Accelerate framework
//! Hardware-accelerated audio processing on Apple Silicon and Intel Macs

#![allow(non_camel_case_types)]

use std::os::raw::c_int;

// vDSP stride type
pub type vDSP_Stride = c_int;
pub type vDSP_Length = usize;

#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    // Vector clip: clips values to [low, high] range
    pub fn vDSP_vclip(
        a: *const f32,
        stride_a: vDSP_Stride,
        low: *const f32,
        high: *const f32,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
    );

    // Vector addition: C = A + B
    pub fn vDSP_vadd(
        a: *const f32,
        stride_a: vDSP_Stride,
        b: *const f32,
        stride_b: vDSP_Stride,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
    );

    // Vector multiply: C = A * B (element-wise)
    pub fn vDSP_vmul(
        a: *const f32,
        stride_a: vDSP_Stride,
        b: *const f32,
        stride_b: vDSP_Stride,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
    );

    // Vector scalar multiply: C = A * scalar
    pub fn vDSP_vsmul(
        a: *const f32,
        stride_a: vDSP_Stride,
        scalar: *const f32,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
    );

    // Vector multiply-add: D = A * B + C
    pub fn vDSP_vma(
        a: *const f32,
        stride_a: vDSP_Stride,
        b: *const f32,
        stride_b: vDSP_Stride,
        c: *const f32,
        stride_c: vDSP_Stride,
        d: *mut f32,
        stride_d: vDSP_Stride,
        n: vDSP_Length,
    );

    // Vector scalar multiply-add: D = A * scalar + B
    pub fn vDSP_vsma(
        a: *const f32,
        stride_a: vDSP_Stride,
        scalar: *const f32,
        b: *const f32,
        stride_b: vDSP_Stride,
        d: *mut f32,
        stride_d: vDSP_Stride,
        n: vDSP_Length,
    );

    // Mean of squares (for RMS calculation)
    pub fn vDSP_measqv(
        a: *const f32,
        stride: vDSP_Stride,
        result: *mut f32,
        n: vDSP_Length,
    );

    // Maximum value
    pub fn vDSP_maxv(
        a: *const f32,
        stride: vDSP_Stride,
        result: *mut f32,
        n: vDSP_Length,
    );

    // Maximum magnitude (absolute value)
    pub fn vDSP_maxmgv(
        a: *const f32,
        stride: vDSP_Stride,
        result: *mut f32,
        n: vDSP_Length,
    );

    // Clear (fill with zero)
    pub fn vDSP_vclr(
        c: *mut f32,
        stride: vDSP_Stride,
        n: vDSP_Length,
    );

    // Fill with scalar
    pub fn vDSP_vfill(
        scalar: *const f32,
        c: *mut f32,
        stride: vDSP_Stride,
        n: vDSP_Length,
    );

    // Convert decibels to power
    pub fn vDSP_vdbcon(
        a: *const f32,
        stride_a: vDSP_Stride,
        zeroReference: *const f32,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
        flag: u32, // 0 = power, 1 = amplitude
    );

    // Gather from interleaved: extract every stride-th element
    // C[i] = A[i * stride_a]
    pub fn vDSP_vgathr(
        a: *const f32,
        indices: *const vDSP_Length,
        stride_indices: vDSP_Stride,
        c: *mut f32,
        stride_c: vDSP_Stride,
        n: vDSP_Length,
    );
}

/// Safe wrapper for vDSP operations
pub struct VDsp;

impl VDsp {
    /// Deinterleave: extract single channel from interleaved buffer using vDSP stride
    /// input: interleaved buffer [L0, R0, L1, R1, ...]
    /// channel: 0 for L, 1 for R, etc.
    /// num_channels: total channels in interleaved data
    /// output: single channel samples
    #[inline]
    pub fn deinterleave(
        input: &[f32],
        channel: usize,
        num_channels: usize,
        output: &mut [f32],
    ) {
        if num_channels == 0 || channel >= num_channels || input.is_empty() || output.is_empty() {
            return;
        }
        let count = output.len().min(input.len() / num_channels);
        if count == 0 {
            return;
        }
        unsafe {
            // Use vDSP_vsmul with stride to copy every num_channels-th sample starting at offset
            vDSP_vsmul(
                input.as_ptr().add(channel),
                num_channels as i32,
                &1.0f32,
                output.as_mut_ptr(),
                1,
                count,
            );
        }
    }

    /// RMS with stride (for interleaved buffers)
    #[inline]
    pub fn rms_strided(buf: &[f32], offset: usize, stride: usize, count: usize) -> f32 {
        if count == 0 || offset >= buf.len() || stride == 0 {
            return 0.0;
        }
        let actual_count = count.min((buf.len() - offset) / stride + 1);
        if actual_count == 0 {
            return 0.0;
        }
        let mut mean_sq: f32 = 0.0;
        unsafe {
            vDSP_measqv(buf.as_ptr().add(offset), stride as i32, &mut mean_sq, actual_count);
        }
        mean_sq.sqrt()
    }

    /// Peak with stride (for interleaved buffers)
    #[inline]
    pub fn peak_strided(buf: &[f32], offset: usize, stride: usize, count: usize) -> f32 {
        if count == 0 || offset >= buf.len() || stride == 0 {
            return 0.0;
        }
        let actual_count = count.min((buf.len() - offset) / stride + 1);
        if actual_count == 0 {
            return 0.0;
        }
        let mut peak: f32 = 0.0;
        unsafe {
            vDSP_maxmgv(buf.as_ptr().add(offset), stride as i32, &mut peak, actual_count);
        }
        peak
    }

    /// Mix input buffer into interleaved output with gain and stride
    /// This is the DAW-style mixing: out[offset + i*stride] += input[i] * gain
    /// Fully hardware-accelerated using vDSP_vsma
    #[inline]
    pub fn mix_to_interleaved(
        input: &[f32],
        gain: f32,
        output: &mut [f32],
        offset: usize,
        stride: usize,
        count: usize,
    ) {
        if count == 0 || offset >= output.len() {
            return;
        }
        let actual_count = count.min((output.len() - offset) / stride + 1).min(input.len());
        if actual_count == 0 {
            return;
        }
        unsafe {
            // vDSP_vsma: D = A * scalar + B
            // With stride, this writes to every stride-th element
            vDSP_vsma(
                input.as_ptr(),
                1, // input stride = 1 (contiguous)
                &gain,
                output.as_ptr().add(offset),
                stride as i32, // read from output with stride
                output.as_mut_ptr().add(offset),
                stride as i32, // write to output with stride
                actual_count,
            );
        }
    }

    /// Mix two buffers with a gain factor: out = out + (input * gain)
    /// This is the core mixing operation for summing audio sources
    #[inline]
    pub fn mix_add(input: &[f32], gain: f32, output: &mut [f32]) {
        let len = input.len().min(output.len());
        if len == 0 {
            return;
        }
        unsafe {
            vDSP_vsma(
                input.as_ptr(),
                1,
                &gain,
                output.as_ptr(),
                1,
                output.as_mut_ptr(),
                1,
                len,
            );
        }
    }

    /// Apply gain to a buffer in-place: buf = buf * gain
    #[inline]
    pub fn apply_gain(buf: &mut [f32], gain: f32) {
        if buf.is_empty() {
            return;
        }
        unsafe {
            vDSP_vsmul(
                buf.as_ptr(),
                1,
                &gain,
                buf.as_mut_ptr(),
                1,
                buf.len(),
            );
        }
    }

    /// Clear a buffer (fill with zeros)
    #[inline]
    pub fn clear(buf: &mut [f32]) {
        if buf.is_empty() {
            return;
        }
        unsafe {
            vDSP_vclr(buf.as_mut_ptr(), 1, buf.len());
        }
    }

    /// Add two buffers: out = a + b
    #[inline]
    pub fn add(a: &[f32], b: &[f32], out: &mut [f32]) {
        let len = a.len().min(b.len()).min(out.len());
        if len == 0 {
            return;
        }
        unsafe {
            vDSP_vadd(
                a.as_ptr(),
                1,
                b.as_ptr(),
                1,
                out.as_mut_ptr(),
                1,
                len,
            );
        }
    }

    /// Calculate RMS level of a buffer
    #[inline]
    pub fn rms(buf: &[f32]) -> f32 {
        if buf.is_empty() {
            return 0.0;
        }
        let mut mean_sq: f32 = 0.0;
        unsafe {
            vDSP_measqv(buf.as_ptr(), 1, &mut mean_sq, buf.len());
        }
        mean_sq.sqrt()
    }

    /// Get peak (maximum absolute value) of a buffer
    #[inline]
    pub fn peak(buf: &[f32]) -> f32 {
        if buf.is_empty() {
            return 0.0;
        }
        let mut peak: f32 = 0.0;
        unsafe {
            vDSP_maxmgv(buf.as_ptr(), 1, &mut peak, buf.len());
        }
        peak
    }

    /// Convert linear amplitude to dB (with -infinity handling)
    #[inline]
    pub fn to_db(linear: f32) -> f32 {
        if linear <= 0.0 {
            -f32::INFINITY
        } else {
            20.0 * linear.log10()
        }
    }

    /// Convert dB to linear amplitude
    #[inline]
    pub fn from_db(db: f32) -> f32 {
        if db <= -96.0 {
            0.0
        } else {
            10.0_f32.powf(db / 20.0)
        }
    }

    /// Clip buffer values to [low, high] range - hardware accelerated
    /// This is used for clip protection to prevent digital distortion
    #[inline]
    pub fn clip(buf: &mut [f32], low: f32, high: f32) {
        if buf.is_empty() {
            return;
        }
        unsafe {
            vDSP_vclip(
                buf.as_ptr(),
                1,
                &low,
                &high,
                buf.as_mut_ptr(),
                1,
                buf.len(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mix_add() {
        let input = vec![1.0_f32; 256];
        let mut output = vec![0.5_f32; 256];
        VDsp::mix_add(&input, 0.5, &mut output);
        assert!((output[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_rms() {
        let buf = vec![1.0_f32; 256];
        let rms = VDsp::rms(&buf);
        assert!((rms - 1.0).abs() < 0.001);
    }
}
