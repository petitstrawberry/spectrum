//! vDSP bindings for Accelerate framework
//! Hardware-accelerated audio processing on Apple Silicon and Intel Macs

#![allow(non_camel_case_types)]

use std::os::raw::c_int;

// vDSP stride type
pub type vDSP_Stride = c_int;
pub type vDSP_Length = usize;

#[link(name = "Accelerate", kind = "framework")]
extern "C" {
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
}

/// Safe wrapper for vDSP operations
pub struct VDsp;

impl VDsp {
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
