import Foundation
import Cocoa
import AudioUnit
import AVFoundation
import CoreAudioKit
import AudioToolbox

// MARK: - C API Definitions for V2 Support
// SwiftのAudioUnitフレームワークには古いCocoaUIプロパティの定義が含まれていない場合があるため定義
private let kAudioUnitProperty_CocoaUI: AudioUnitPropertyID = 4013

// MARK: - AudioUnitUIManager
final class AudioUnitUIManager: NSObject {
    static let shared = AudioUnitUIManager()

    // インスタンスIDごとの保持用
    // v1に合わせてNSWindowオブジェクトではなくWindowNumber(Int)で管理する
    private var windowNumbers: [String: Int] = [:]
    // ViewControllerは保持しておく必要がある (v1もCACHED_VIEW_CONTROLLERSで保持している)
    private var viewControllers: [String: NSViewController] = [:]

    // V3用: 非同期ロード中に解放されないように保持
    private var auAudioUnits: [String: AUAudioUnit] = [:]

    private override init() {}

    /// メインスレッドで同期的に実行するヘルパー
    private func runOnMainSync(_ block: () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.sync(execute: block)
        }
    }

    /// AudioUnit UIを開く
    /// - Parameters:
    ///   - instanceId: ウィンドウ識別用ID
    ///   - ptr: AudioUnitのポインタ (V2なら AudioComponentInstance, V3なら AUAudioUnit*)
    ///   - isV3: V3 (AUAudioUnit) かどうか。falseの場合はV2 (C API) として扱う
    ///   - pluginName: ウィンドウタイトル用
    func open(instanceId: String, ptr: UnsafeRawPointer?, isV3: Bool, pluginName: String) -> Bool {
        guard let ptr = ptr else { return false }
        var success = false

        runOnMainSync {

            // 既に開いている場合は最前面へ
            if let windowNumber = self.windowNumbers[instanceId],
               let window = NSApp.window(withWindowNumber: windowNumber) {
                    window.makeKeyAndOrderFront(nil)
                    success = true
                    return
            }

            // ウィンドウ作成
            let window = NSWindow(
                contentRect: NSRect(x: 100, y: 100, width: 600, height: 400),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            window.title = "\(pluginName) - Plugin"
            window.center()

            // v1に合わせて、閉じたら破棄されるようにする (WindowNumber管理なのでこれで安全)
            window.isReleasedWhenClosed = true

            window.level = .floating // v1に合わせてフローティングレベルに設定
            window.isOpaque = true
            window.hasShadow = true
            window.backgroundColor = NSColor.windowBackgroundColor

            // ビューのロード
            if isV3 {
                self.loadV3UI(ptr: ptr, window: window, instanceId: instanceId)
            } else {
                self.loadV2UI(ptr: ptr, window: window, instanceId: instanceId)
            }

            self.windowNumbers[instanceId] = window.windowNumber
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true) // アプリケーションをアクティブにしてイベントを受け取れるようにする
            success = true
        }

        return success
    }

    // MARK: - V3 (AUAudioUnit) Loading
    private func loadV3UI(ptr: UnsafeRawPointer, window: NSWindow, instanceId: String) {
        // ポインタをAUAudioUnitとして解釈
        let au = Unmanaged<AUAudioUnit>.fromOpaque(ptr).takeUnretainedValue()

        // 非同期処理が終わるまで保持しておく
        self.auAudioUnits[instanceId] = au

        au.requestViewController { [weak self] viewController in
            guard let self = self else { return }

            DispatchQueue.main.async {
                // ウィンドウが既に閉じられていたら何もしない
                guard let windowNumber = self.windowNumbers[instanceId],
                      let window = NSApp.window(withWindowNumber: windowNumber) else { return }

                if let vc = viewController {
                    self.embedViewController(vc, into: window, instanceId: instanceId)
                } else {
                    self.showPlaceholder(window: window, message: "No UI available")
                }
            }
        }
    }

    // MARK: - V2 (AudioComponentInstance) Loading
    private func loadV2UI(ptr: UnsafeRawPointer, window: NSWindow, instanceId: String) {
        // ポインタをAudioUnit (C API) として解釈
        let audioUnit = ptr.assumingMemoryBound(to: OpaquePointer.self) // AudioComponentInstance

        // 1. Cocoa UI (Custom View) の取得を試みる
        if let customView = createV2CocoaView(audioUnit: audioUnit) {
            embedView(customView, into: window)
            return
        }

        // 2. 失敗したら Generic View (CoreAudioKit) を試みる
        loadGenericView(audioUnit: audioUnit, window: window)
    }

    private func createV2CocoaView(audioUnit: UnsafeRawPointer) -> NSView? {
        // AudioUnitGetPropertyを使ってkAudioUnitProperty_CocoaUIを取得する
        // 構造体: { CFURLRef bundleLoc, CFStringRef className }

        var dataSize: UInt32 = 0
        var writable: DarwinBoolean = false

        // AudioUnit (C-API) の関数ポインタ定義が必要だが、SwiftからはAudioUnitGetPropertyを直接呼べる
        // ただし、AudioUnit型は OpaquePointer ではなく AudioComponentInstance (typealias)
        let au = unsafeBitCast(audioUnit, to: AudioUnit.self)

        let err = AudioUnitGetPropertyInfo(au, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &dataSize, &writable)

        if err != noErr || dataSize == 0 {
            return nil
        }

        // データを取得
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(dataSize), alignment: 8)
        defer { buffer.deallocate() }

        let err2 = AudioUnitGetProperty(au, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, buffer, &dataSize)
        if err2 != noErr {
            return nil
        }

        // 構造体のメンバを読み取る
        // struct AudioUnitCocoaViewInfo { CFURLRef; CFStringRef; }
        // CFURLRefはポインタサイズ、CFStringRefもポインタサイズ
        let urlPtr = buffer.load(fromByteOffset: 0, as: CFURL.self)
        let classNamePtr = buffer.load(fromByteOffset: MemoryLayout<CFURL>.size, as: CFString.self)

        // バンドルをロード
        guard let bundle = Bundle(url: urlPtr as URL) else { return nil }
        if !bundle.isLoaded {
            guard bundle.load() else { return nil }
        }

        // クラスを取得してインスタンス化
        let className = classNamePtr as String
        guard let viewClass = bundle.classNamed(className) as? NSObject.Type else { return nil }

        // プロトコル AUCocoaUIBase (非公式) または単純なメソッド呼び出し
        // func uiView(forAudioUnit: AudioUnit, withSize: NSSize) -> NSView

        let factory = viewClass.init()
        let selector = Selector(("uiViewForAudioUnit:withSize:"))

        if factory.responds(to: selector) {
            // Unmanagedを使ってメソッド呼び出し
            let size = NSSize(width: 600, height: 400)
            let result = factory.perform(selector, with: audioUnit, with: size)

            if let unmanagedView = result {
                return unmanagedView.takeUnretainedValue() as? NSView
            }
        }

        return nil
    }

    private func loadGenericView(audioUnit: UnsafeRawPointer, window: NSWindow) {
        // AUGenericView (CoreAudioKit)
        // init(audioUnit: AudioUnit)
        // AudioUnit型は @convention(c) なので OpaquePointer へのキャストが必要な場合があるが
        // AUGenericViewは古いAPIなので AudioComponentInstance を期待する

        let au = unsafeBitCast(audioUnit, to: AudioUnit.self)
        // AUGenericViewはCoreAudioKitに含まれる
        let genericView = AUGenericView(audioUnit: au)
        // displayFlagsなどを設定可能
        genericView.showsExpertParameters = true

        embedView(genericView, into: window)
    }

    // MARK: - Helper Methods

    private func embedViewController(_ viewController: NSViewController, into window: NSWindow, instanceId: String) {
        viewControllers[instanceId] = viewController
        // Responder Chainを正しく機能させるためにcontentViewControllerを設定する
        // これによりNSPopUpButtonなどのメニューイベントが正しく処理される
        window.contentViewController = viewController
        resizeWindow(window, toFit: viewController.view)
    }

    private func embedView(_ view: NSView, into window: NSWindow) {
        // spectrum-v1の実装に合わせて、Layer-backed ViewとAuto Layoutを使用する
        guard let container = window.contentView else { return }

        container.wantsLayer = true
        view.wantsLayer = true
        view.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(view)

        // リサイズ対応判定 (v1のロジック)
        // NSViewWidthSizable(2) | NSViewHeightSizable(16)
        let mask = view.autoresizingMask
        let isResizable = mask.contains(.width) && mask.contains(.height)

        // ウィンドウのスタイルを調整
        if isResizable {
            window.styleMask.insert(.resizable)
        } else {
            window.styleMask.remove(.resizable)
        }

        // 制約の設定
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])

        // 優先度の設定 (v1のロジック)
        // リサイズ不可の場合は優先度を高くして変形を防ぐ
        let priority: NSLayoutConstraint.Priority = isResizable ? .defaultLow : .required

        view.setContentHuggingPriority(priority, for: .horizontal)
        view.setContentHuggingPriority(priority, for: .vertical)
        view.setContentCompressionResistancePriority(priority, for: .horizontal)
        view.setContentCompressionResistancePriority(priority, for: .vertical)

        // Layer設定の再確保 (v1でも最後に行っている)
        view.wantsLayer = true

        resizeWindow(window, toFit: view)
    }

    private func resizeWindow(_ window: NSWindow, toFit view: NSView) {
        let fittingSize = view.fittingSize
        if fittingSize.width > 50 && fittingSize.height > 50 {
            var frame = window.frame
            let contentRect = window.contentRect(forFrameRect: frame)
            let deltaW = fittingSize.width - contentRect.width
            let deltaH = fittingSize.height - contentRect.height
            frame.size.width += deltaW
            frame.size.height += deltaH
            frame.origin.y -= deltaH
            window.setFrame(frame, display: true)
        }
    }

    private func showPlaceholder(window: NSWindow, message: String) {
        let label = NSTextField(labelWithString: message)
        label.alignment = .center
        label.frame = NSRect(x: 0, y: 0, width: 400, height: 200)
        window.contentView = label
    }

    // ウィンドウが閉じた時、または明示的に閉じる時に呼ばれるクリーンアップ処理
    func cleanup(instanceId: String) {
        runOnMainSync {
            windowNumbers.removeValue(forKey: instanceId)
            viewControllers.removeValue(forKey: instanceId)
            auAudioUnits.removeValue(forKey: instanceId)
        }
    }

    func close(instanceId: String) {
        runOnMainSync {
            if let windowNumber = windowNumbers.removeValue(forKey: instanceId),
               let window = NSApp.window(withWindowNumber: windowNumber) {
                window.close()
            }
            cleanup(instanceId: instanceId)
        }
    }

    func closeAll() {
        runOnMainSync {
            for windowNumber in windowNumbers.values {
                NSApp.window(withWindowNumber: windowNumber)?.close()
            }
            windowNumbers.removeAll()
            viewControllers.removeAll()
            auAudioUnits.removeAll()
        }
    }

    func isOpen(instanceId: String) -> Bool {
        var result = false
        runOnMainSync {
            if let windowNumber = windowNumbers[instanceId] {
                // ウィンドウ番号が存在し、かつNSAppがそのウィンドウを見つけられるか確認
                result = NSApp.window(withWindowNumber: windowNumber) != nil
            }
        }
        return result
    }
}

// MARK: - C Exports

@_cdecl("swift_open_audio_unit_ui")
public func swift_open_audio_unit_ui(
    cInstanceId: UnsafePointer<CChar>?,
    auPtr: UnsafeRawPointer?,
    isV3: Bool, // Rust側で true/false を渡すように変更してください
    pluginName: UnsafePointer<CChar>?
) -> Int32 {

    guard let cInstanceId = cInstanceId, let pluginName = pluginName, let auPtr = auPtr else { return -1 }
    let instanceId = String(cString: cInstanceId)
    let name = String(cString: pluginName)

    NSLog("[AudioUnitUI] Open UI: \(instanceId), isV3: \(isV3)")

    let success = AudioUnitUIManager.shared.open(instanceId: instanceId, ptr: auPtr, isV3: isV3, pluginName: name)
    return success ? 0 : -1
}

@_cdecl("swift_close_audio_unit_ui")
public func swift_close_audio_unit_ui(cInstanceId: UnsafePointer<CChar>?) {
    guard let cInstanceId = cInstanceId else { return }
    AudioUnitUIManager.shared.close(instanceId: String(cString: cInstanceId))
}

@_cdecl("swift_is_plugin_window_open")
public func swift_is_plugin_window_open(cInstanceId: UnsafePointer<CChar>?) -> Bool {
    guard let cInstanceId = cInstanceId else { return false }
    return AudioUnitUIManager.shared.isOpen(instanceId: String(cString: cInstanceId))
}

@_cdecl("swift_close_all_plugin_windows")
public func swift_close_all_plugin_windows() {
    AudioUnitUIManager.shared.closeAll()
}
