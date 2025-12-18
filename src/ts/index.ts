/**
 * LittleFS WebAssembly - Main Entry Point
 * 
 * @example
 * ```typescript
 * import { createLittleFS, DISK_VERSION_2_0 } from 'littlefs-wasm';
 * 
 * // Create filesystem with explicit disk version to prevent migration
 * const fs = await createLittleFS({
 *   blockSize: 4096,
 *   blockCount: 256,
 *   formatOnInit: true,
 *   diskVersion: DISK_VERSION_2_0,  // Use v2.0 for compatibility
 * });
 * 
 * fs.writeFile('/hello.txt', 'Hello, World!');
 * fs.mkdir('/data');
 * fs.writeFile('/data/config.json', JSON.stringify({ version: 1 }));
 * 
 * const entries = fs.list('/');
 * console.log(entries);
 * 
 * // Check disk version
 * console.log('Disk version:', formatDiskVersion(fs.getDiskVersion()));
 * 
 * const image = fs.toImage();
 * // Flash image to ESP device...
 * 
 * fs.destroy();
 * ```
 */

export {
  createLittleFS,
  createLittleFSFromImage,
  LittleFSError,
  DISK_VERSION_2_0,
  DISK_VERSION_2_1,
  formatDiskVersion,
  type LittleFS,
  type LittleFSEntry,
  type LittleFSOptions,
} from './littlefs/index';

export {
  type FileSource,
  type BinarySource,
  toUint8Array,
} from './shared/types';
