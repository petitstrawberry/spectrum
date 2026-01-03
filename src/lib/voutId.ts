/**
 * Shared constants for virtual output device ID parsing
 */

/**
 * Regular expression pattern for parsing virtual output device IDs.
 * 
 * Supports both formats:
 * - Old: vout_{device_id}_{offset}
 * - New: vout_{device_id}_{offset}_{uid_hash}
 * 
 * Capture groups:
 * 1. device_id (number)
 * 2. offset (number)
 * 3. uid_hash (optional hex string)
 */
export const VOUT_ID_PATTERN = /^vout_(\d+)_(\d+)(?:_([a-f0-9]+))?$/;

/**
 * Parse a virtual output device ID
 * @param id Virtual output device ID string
 * @returns Object with deviceId, offset, and optional uidHash, or null if invalid
 */
export function parseVoutId(id: string): { deviceId: number; offset: number; uidHash?: string } | null {
  const match = id.match(VOUT_ID_PATTERN);
  if (!match) return null;
  
  return {
    deviceId: Number(match[1]),
    offset: Number(match[2]),
    uidHash: match[3],
  };
}
