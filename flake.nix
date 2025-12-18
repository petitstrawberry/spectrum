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
          ];

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

            # Prefer the system Xcode when available to avoid a Nix-provided
            # macOS SDK mismatch with the locally installed Swift compiler.
            if [ -d /Applications/Xcode.app/Contents/Developer ]; then
              export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
              unset SDKROOT
              echo "   Using system Xcode: $DEVELOPER_DIR"
            fi
          '';
        };
      }
    );
}
