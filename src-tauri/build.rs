use std::process::Command;
use std::env;
use std::path::PathBuf;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();

    // macOSの場合のみSwiftをビルドしてリンクする
    if target_os == "macos" {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

        // Swiftファイルのパス
        // ※ プロジェクト構成に合わせてパスを調整してください。
        //    通常は src-tauri/swift/AudioUnitUI.swift にあると仮定しています。
        let swift_file = manifest_dir.join("swift/AudioUnitUI.swift");

        if swift_file.exists() {
            // 1. 【重要】変更検知: Swiftファイルが変わったら再ビルドするようCargoに通知
            println!("cargo:rerun-if-changed={}", swift_file.display());

            let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
            let lib_name = "AudioUnitUI";
            let lib_filename = format!("lib{}.a", lib_name);
            let lib_path = out_dir.join(&lib_filename);

            // 2. コンパイル: swiftcを使って静的ライブラリ (.a) を作成
            // -emit-library: ライブラリを出力
            // -static: 静的リンク
            let status = Command::new("swiftc")
                .args(&["-emit-library", "-static"])
                .arg("-o").arg(&lib_path)
                .arg(&swift_file)
                .status()
                .expect("Failed to execute swiftc");

            if !status.success() {
                panic!("Swift compilation failed");
            }

            // 3. リンク設定: Rust側にライブラリとフレームワークを教える
            println!("cargo:rustc-link-search=native={}", out_dir.display());
            println!("cargo:rustc-link-lib=static={}", lib_name);

            // 4. Swiftランタイムのパスを追加 (リンクエラー回避のため必須)
            let sdk_path = Command::new("xcrun")
                .args(&["--sdk", "macosx", "--show-sdk-path"])
                .output()
                .expect("Failed to get SDK path")
                .stdout;
            let sdk_path_str = String::from_utf8(sdk_path).unwrap().trim().to_string();

            println!("cargo:rustc-link-search=native={}/usr/lib/swift", sdk_path_str);
            println!("cargo:rustc-link-search=native=/usr/lib/swift");

            // Swiftコード内で使用しているフレームワークをリンク
            println!("cargo:rustc-link-lib=framework=Cocoa");
            println!("cargo:rustc-link-lib=framework=AudioUnit");
            println!("cargo:rustc-link-lib=framework=AVFoundation");
            println!("cargo:rustc-link-lib=framework=CoreAudioKit");
            println!("cargo:rustc-link-lib=framework=CoreAudio");
            println!("cargo:rustc-link-lib=framework=AudioToolbox");
            println!("cargo:rustc-link-lib=framework=Carbon");
        } else {
            println!("cargo:warning=Swift file not found at: {}", swift_file.display());
        }
    }

    // Tauriの標準ビルド処理
    tauri_build::build()
}
