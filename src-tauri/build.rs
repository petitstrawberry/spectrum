fn main() {
    // Link Accelerate framework for vDSP hardware-accelerated audio processing
    println!("cargo:rustc-link-lib=framework=Accelerate");

    tauri_build::build()
}
