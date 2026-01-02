# Spectrum

**[English](README.md)** | 日本語


**Spectrum** は macOS 向けの **オーディオミキサー & ルーター** です。複数の音声ソースから任意の出力デバイスへ、ビジュアルなグラフベースのインターフェースでミキシング・ルーティング・処理を行います。

> **Prism**（仮想オーディオ分離ドライバ）と組み合わせることで、アプリごとの音声をキャプチャして独立してルーティング可能 — ストリーミング、録音、複雑なモニタリングセットアップに最適です。


## Spectrum でできること

- **ビジュアルなオーディオルーティング**: ノードベースのグラフで任意の入力と出力を接続
- **アプリ単位でのコントロール**: Discord、Spotify、ゲーム音声などを別々の出力先へルーティング（Prism が必要）
- **リアルタイムミキシング**: レベル調整、ミュート、ライブメーター表示
- **AudioUnit エフェクト**: リバーブ、EQ、コンプレッサーなど AU プラグインを任意のバスに追加
- **マルチデバイス出力**: ヘッドフォン、スピーカー、録音ソフトに同時出力


## 前提条件

- **macOS**（10.15 以降）
- **Xcode Command Line Tools**: `xcode-select --install`


## クイックスタート

### ユーザー向け

1. **Spectrum をダウンロード**（またはソースからビルド — 後述の開発セクション参照）

2. **Prism をインストール**（オプション、アプリ単位のルーティングに必要）:
   ```bash
   cd prism
   cargo install --path .
   ./build_driver.sh
   sudo ./install.sh
   # macOS を再起動
   ```

3. **Prism デーモンを起動**（Prism を使う場合）:
   ```bash
   prismd --daemonize
   ```

4. **Spectrum を起動**してオーディオルーティングを開始！


## 既知の問題

### AudioUnit プラグイン UI — JUCE プリセットメニューが動作しない

**問題**: JUCE フレームワークで作られた AudioUnit プラグインは UI が正しく表示されますが、プリセットメニュー（ドロップダウン／ポップアップメニュー）がクリックに反応しません。

**原因**: JUCE プラグインは別のネイティブウィンドウでメニューを開きます。現在、Spectrum の AudioUnit UI ホスティングは、これらの分離されたウィンドウへのイベント伝播を適切に行っていません。

**回避策**: 
- プリセットの代わりにプラグインのパラメータコントロールを直接使用
- または、プラグインのスタンドアロンアプリでプリセット管理を行い、Spectrum でプラグインをリロード

**ステータス**: 別の NSWindow インスタンスへのイベント伝播を調査中。技術的な詳細は `docs/plugin-ui-menu-issue-investigation.md` を参照。


## 開発

### リポジトリ構成

- `src/` — フロントエンド（React UI）
- `src-tauri/` — バックエンド（Rust / Tauri）
- `docs/` — v2 アーキテクチャと改善計画

### セットアップ

**前提条件:**
- **Node.js** と **pnpm**
- **Rust toolchain**（`rust-toolchain.toml` に従う）

**Nix を使う場合（オプション）:**
```bash
nix develop
```

### 実行

1. **依存関係のインストール**
   ```bash
   pnpm install
   ```

2. **フロントエンドのみ実行**（UI 開発サーバー）
   ```bash
   pnpm dev
   ```
   - Vite dev server: http://localhost:1420

3. **デスクトップアプリとして実行**（Tauri）
   ```bash
   pnpm tauri dev
   ```
   > UI とバックエンドを自動的に起動

### ビルド

```bash
pnpm build
pnpm tauri build
```


## ドキュメント

- **ドキュメント索引**: `docs/README.md`
- **v2 アーキテクチャ（必読）**: `docs/architecture-v2.md`
- **改善計画（パフォーマンス/Lock-free 等）**: `docs/improvements.md`


## Prism について

**Prism** は macOS の仮想オーディオ分離ドライバで、アプリごとの音声を 64ch バスに割り当てます。**Spectrum** はミキサー／ルーターとして機能し、それらのチャンネルを入力ソースとして受け取り、出力デバイスへルーティングします。

Prism のビルド／インストール／使い方: `prism/README.md` を参照


## ライセンス

Spectrum は [MIT ライセンス](LICENSE) の下でライセンスされています。
