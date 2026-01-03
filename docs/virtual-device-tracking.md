# Virtual Device Tracking with UIDs

## Problem Statement

When an aggregate audio device's configuration changes (sub-devices added or removed), virtual devices that no longer exist are not properly disabled or enabled. This is because the previous implementation used a channel offset-based ID (`vout_{device_id}_{offset}`) which doesn't uniquely identify the physical sub-device across configuration changes.

### Example Scenario

Consider an aggregate device with 3 sub-devices:
```
Initial Configuration:
- Device A: channels 0-1   -> vout_100_0
- Device B: channels 2-3   -> vout_100_2
- Device C: channels 4-5   -> vout_100_4
```

If Device A is removed:
```
New Configuration:
- Device B: channels 0-1   -> vout_100_0 (was vout_100_2)
- Device C: channels 2-3   -> vout_100_2 (was vout_100_4)
```

The IDs change because they're based on channel offsets, not the actual device identity. This breaks node references and causes devices to not be properly disabled/enabled.

## Solution

Use the device UID (Unique Identifier provided by CoreAudio) to create stable virtual device IDs that persist across configuration changes.

### New ID Format

- **Old format**: `vout_{device_id}_{offset}`
- **New format**: `vout_{device_id}_{offset}_{uid_hash}`

Where `uid_hash` is an 8-character hexadecimal hash of the sub-device's UID.

### Example with UIDs

```
Initial Configuration:
- Device A (UID: AppleUSB:123): channels 0-1   -> vout_100_0_a1b2c3d4
- Device B (UID: AppleUSB:456): channels 2-3   -> vout_100_2_e5f6a7b8
- Device C (UID: AppleUSB:789): channels 4-5   -> vout_100_4_c9d0e1f2
```

After removing Device A:
```
New Configuration:
- Device B (UID: AppleUSB:456): channels 0-1   -> vout_100_0_e5f6a7b8
- Device C (UID: AppleUSB:789): channels 2-3   -> vout_100_2_c9d0e1f2
```

Now Device B maintains a consistent identity (uid_hash: e5f6a7b8) even though its channel offset changed.

## Implementation Details

### Backend (Rust)

1. **UID Hashing Function** (`src-tauri/src/device/enumerate.rs`)
   ```rust
   fn uid_hash(uid: &str) -> String {
       let mut hash: u64 = 0;
       for byte in uid.as_bytes() {
           hash = hash.wrapping_mul(31).wrapping_add(*byte as u64);
       }
       format!("{:08x}", hash)
   }
   ```

2. **Virtual Device ID Generation**
   - For aggregate sub-devices with UID: `vout_{device_id}_{offset}_{uid_hash}`
   - For aggregate sub-devices without UID: `vout_{device_id}_{offset}` (fallback)
   - For regular devices: `vout_{device_id}_0`

3. **Parsing Support**
   - `find_output_device()` accepts both 3-part and 4-part IDs
   - Backward compatible with old saved configurations

### Frontend (TypeScript)

Updated regex patterns from:
```typescript
/^vout_(\d+)_(\d+)$/
```

To:
```typescript
/^vout_(\d+)_(\d+)(?:_([a-f0-9]+))?$/
```

The `(?:_([a-f0-9]+))?` part makes the UID hash optional:
- `(?:...)` - non-capturing group
- `_([a-f0-9]+)` - underscore followed by hex characters
- `?` - makes the entire group optional

Files updated:
- `src/hooks/useDevices.ts` (1 pattern)
- `src/ui/SpectrumLayout.tsx` (8 patterns)
- `src/ui/CanvasView.tsx` (1 pattern)

## Benefits

1. **Stable Device Identity**: Virtual devices maintain consistent IDs across aggregate configuration changes
2. **Proper Activation/Deactivation**: Devices that no longer exist can be properly disabled
3. **Backward Compatibility**: Old saved configurations continue to work
4. **Minimal Changes**: Uses existing `subdevice_uid` field from `OutputDeviceDto`

## Testing

Added unit tests in `src-tauri/src/device/enumerate.rs`:
- `test_uid_hash()` - Verifies hash consistency and format
- `test_find_output_device_old_format()` - Tests parsing old 3-part IDs
- `test_find_output_device_new_format()` - Tests parsing new 4-part IDs
- `test_find_output_device_invalid_format()` - Tests error handling

## Migration

No migration needed. The implementation is fully backward compatible:
- Old IDs (`vout_123_0`) continue to work
- New aggregate devices will use the new format automatically
- Mixed usage of old and new IDs is supported
