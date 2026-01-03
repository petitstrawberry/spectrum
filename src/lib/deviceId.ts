/**
 * Shared constants for device ID parsing
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
 * Regular expression pattern for parsing input device IDs.
 * 
 * Supports both formats:
 * - Old: in_{device_id}
 * - New: in_{device_id}_{uid_hash}
 * 
 * Capture groups:
 * 1. device_id (number)
 * 2. uid_hash (optional hex string)
 */
export const INPUT_ID_PATTERN = /^in_(\d+)(?:_([a-f0-9]+))?$/;

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

/**
 * Parse an input device ID
 * @param id Input device ID string
 * @returns Object with deviceId and optional uidHash, or null if invalid
 */
export function parseInputId(id: string): { deviceId: number; uidHash?: string } | null {
  const match = id.match(INPUT_ID_PATTERN);
  if (!match) return null;
  
  return {
    deviceId: Number(match[1]),
    uidHash: match[2],
  };
}
