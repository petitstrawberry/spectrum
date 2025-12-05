{
  description = "Spectrum - Prism Audio Mixer/Router";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-24.11-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustup
            nodejs_22
            pnpm
            # Tauri dependencies
            pkg-config
            libiconv
          ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin (with pkgs.darwin.apple_sdk.frameworks; [
            WebKit
            CoreServices
            CoreFoundation
            CoreAudio
            AudioToolbox
            Security
            AppKit
          ]);

          shellHook = ''
            export PATH="$HOME/.cargo/bin:$PATH"

            channel=stable
            if [ -f rust-toolchain.toml ]; then
              channel=$(awk -F'"' '/channel/ {print $2; exit}' rust-toolchain.toml || echo stable)
            fi

            if command -v rustup >/dev/null 2>&1; then
              rustup toolchain install "$channel" --no-self-update >/dev/null 2>&1 || true
              rustup component add rustfmt clippy rust-src --toolchain "$channel" >/dev/null 2>&1 || true
              rustup override set "$channel" >/dev/null 2>&1 || true
            fi

            echo "🎛️  Spectrum development environment loaded"
            echo "   Node.js: $(node --version)"
            echo "   pnpm: $(pnpm --version)"
            if command -v cargo >/dev/null 2>&1; then
              echo "   Cargo: $(cargo --version)"
            fi
          '';
        };
      }
    );
}
