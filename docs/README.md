# Spectrum Documentation Index

このディレクトリは Spectrum v2 アーキテクチャの技術ドキュメント集です。

---

## 📚 ドキュメント構成

### 必読ドキュメント

| ドキュメント | 目的 | 読者 |
|------------|------|------|
| **[architecture-v2.md](./architecture-v2.md)** | v2アーキテクチャの完全仕様 | 全員 |
| **[improvements.md](./improvements.md)** | 改善提案と実装計画の統合版 | 開発者 |

---

## 📖 ドキュメント詳細

### [architecture-v2.md](./architecture-v2.md)

**内容**:
- Pure Sends-on-Fader 設計思想
- 型設計（NodeHandle, Edge, AudioNode trait）
- API設計（Tauri commands）
- データフロー図
- 実装進捗状況

**位置づけ**: **全ての基礎となる不変のドキュメント**

**更新方針**:
- 実装完了時のみ更新
- 設計変更は慎重に検討

---

### [improvements.md](./improvements.md)

**内容**:
- 現状の問題点評価
- Lock-free 設計の3つのアプローチ
  1. Clone ベース（Phase 1-4の詳細計画）
  2. Atomic のみ（最小限変更）
  3. Pure ArcSwap（最終推奨案）
- 実装優先順位とスケジュール
- ベンチマーク目標値
- リスク管理

**位置づけ**: **改善提案の決定版 - 実装前に読むべきドキュメント**

**読み方**:
1. 「現状評価」で問題点を理解
2. 「3つのアプローチ比較」で選択肢を理解
3. 「推奨案」で実装方針を確認
4. 「実装計画」で具体的な作業を把握

---

## 🗂️ 削除されたドキュメント

以下は `improvements.md` に統合されました:

- ~~`architecture-evaluation.md`~~ → `improvements.md` の「現状評価」セクション
- ~~`implementation-plan.md`~~ → `improvements.md` の「実装計画」セクション
- ~~`lock-free-design-alternative.md`~~ → `improvements.md` の「アプローチ2」セクション
- ~~`lock-free-design-final.md`~~ → `improvements.md` の「アプローチ3（推奨）」セクション

---

## 🚀 クイックスタート

### 新規参加者向け

1. **[architecture-v2.md](./architecture-v2.md)** を読む（30分）
   - Pure Sends-on-Fader の理解
   - 型設計とAPI設計の把握

2. **[improvements.md](./improvements.md)** の「現状評価」を読む（15分）
   - 現在の実装状況の理解
   - 問題点の把握

3. コードを読む
   - `src-tauri/src/audio/` - コア実装
   - `src-tauri/src/api/` - Tauri API

### 改善実装者向け

1. **[improvements.md](./improvements.md)** の「推奨案」を読む（30分）
   - Pure ArcSwap 設計の理解
   - 実装方針の把握

2. **[improvements.md](./improvements.md)** の「実装計画」を読む（30分）
   - Phase 1-3 の詳細理解
   - スケジュール確認

3. 実装開始
   - Phase 1: Edge Atomic化から着手

---

## 📝 ドキュメント更新ガイドライン

### architecture-v2.md

- ✅ **更新すべき場合**: 実装完了、設計確定
- ❌ **更新すべきでない場合**: 提案段階、実験的変更

### improvements.md

- ✅ **更新すべき場合**: 新しい問題発見、実装完了
- ✅ **追記すべき場合**: 新しいアプローチ提案

---

## 🔗 関連リソース

### コードベース

- `src-tauri/src/audio/` - オーディオエンジン本体
- `src-tauri/src/api/` - Tauri コマンド実装
- `src/hooks/` - React フック（UI側）
- `src/lib/api.ts` - TypeScript API クライアント

### 外部リンク

- [Lock-free Programming](https://www.1024cores.net/home/lock-free-algorithms)
- [arc-swap crate](https://docs.rs/arc-swap/)
- [Rust Atomics and Locks](https://marabos.nl/atomics/)

---

**最終更新**: 2025-12-12
**管理者**: Spectrum 開発チーム
