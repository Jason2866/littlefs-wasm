/**
 * LittleFS WebAssembly Bindings
 * 
 * Provides a TypeScript-first API for LittleFS compiled to WebAssembly.
 * All filesystem operations happen in RAM and can be exported as binary images.
 */

import type { FileSource, BinarySource } from '../shared/types';
import { toUint8Array } from '../shared/types';

// ============================================================================
// Constants
// ============================================================================

/**
 * LittleFS disk version 2.0 (0x00020000)
 * Use this for maximum compatibility with older implementations.
 * This is the default when creating new filesystems.
 */
export const DISK_VERSION_2_0 = 0x00020000;

/**
 * LittleFS disk version 2.1 (0x00020001)
 * Latest version with additional features.
 */
export const DISK_VERSION_2_1 = 0x00020001;

/**
 * Helper to format disk version as human-readable string
 */
export function formatDiskVersion(version: number): string {
  const major = (version >> 16) & 0xffff;
  const minor = version & 0xffff;
  return `${major}.${minor}`;
}

// ============================================================================
// Types
// ============================================================================

export interface LittleFSEntry {
  path: string;
  size: number;
  type: 'file' | 'dir';
}

export interface LittleFSOptions {
  blockSize?: number;
  blockCount?: number;
  lookaheadSize?: number;
  /**
   * Optional override for the wasm asset location.
   */
  wasmURL?: string | URL;
  /**
   * Formats the filesystem immediately after initialization.
   */
  formatOnInit?: boolean;
  /**
   * Disk version to use when formatting new filesystems.
   * Use LittleFS disk version constants:
   * - DISK_VERSION_2_0 (0x00020000) - Compatible with older implementations
   * - DISK_VERSION_2_1 (0x00020001) - Latest version
   * - 0 or undefined - Use latest version
   * 
   * IMPORTANT: Setting this prevents automatic migration of older filesystems.
   */
  diskVersion?: number;
}

export interface LittleFS {
  format(): void;
  list(path?: string): LittleFSEntry[];
  addFile(path: string, data: FileSource): void;
  writeFile(path: string, data: FileSource): void;
  deleteFile(path: string): void;
  delete(path: string, options?: { recursive?: boolean }): void;
  mkdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  toImage(): Uint8Array;
  readFile(path: string): Uint8Array;
  getUsage(): { used: number; total: number; free: number };
  /**
   * Get the disk version of the mounted filesystem.
   * Returns version as 32-bit number (e.g., 0x00020000 for v2.0, 0x00020001 for v2.1)
   */
  getDiskVersion(): number;
  destroy(): void;
}

// ============================================================================
// Error Handling
// ============================================================================

export class LittleFSError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = 'LittleFSError';
  }
}

const ERROR_MESSAGES: Record<number, string> = {
  [-1]: 'I/O error',
  [-2]: 'Corrupted filesystem',
  [-3]: 'No such file or directory',
  [-4]: 'Entry already exists',
  [-5]: 'Entry is not a directory',
  [-6]: 'Entry is a directory',
  [-7]: 'Directory not empty',
  [-9]: 'Bad file descriptor',
  [-10]: 'File too large',
  [-11]: 'Invalid parameter',
  [-12]: 'No space left on device',
  [-13]: 'No memory available',
  [-17]: 'No attribute available',
  [-22]: 'Filename too long',
};

function checkError(code: number, context: string): void {
  if (code < 0) {
    const msg = ERROR_MESSAGES[code] || `Unknown error (${code})`;
    throw new LittleFSError(`${context}: ${msg}`, code);
  }
}

// ============================================================================
// WASM Module Interface
// ============================================================================

interface LittleFSModule {
  _lfs_wasm_init(blockSize: number, blockCount: number, lookahead: number): number;
  _lfs_wasm_init_from_image(imagePtr: number, imageSize: number, blockSize: number): number;
  _lfs_wasm_set_disk_version(version: number): void;
  _lfs_wasm_get_disk_version(): number;
  _lfs_wasm_get_fs_info(versionPtr: number): number;
  _lfs_wasm_mount(): number;
  _lfs_wasm_unmount(): number;
  _lfs_wasm_format(): number;
  _lfs_wasm_mkdir(pathPtr: number): number;
  _lfs_wasm_remove(pathPtr: number): number;
  _lfs_wasm_rename(oldPtr: number, newPtr: number): number;
  _lfs_wasm_stat(pathPtr: number, typePtr: number, sizePtr: number): number;
  _lfs_wasm_dir_open(pathPtr: number): number;
  _lfs_wasm_dir_read(handle: number, namePtr: number, nameLen: number, typePtr: number, sizePtr: number): number;
  _lfs_wasm_dir_close(handle: number): number;
  _lfs_wasm_write_file(pathPtr: number, dataPtr: number, size: number): number;
  _lfs_wasm_read_file(pathPtr: number, outPtr: number, maxSize: number): number;
  _lfs_wasm_file_size(pathPtr: number): number;
  _lfs_wasm_get_image(): number;
  _lfs_wasm_get_image_size(): number;
  _lfs_wasm_fs_stat(usedPtr: number, totalPtr: number): number;
  _lfs_wasm_cleanup(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
}

// ============================================================================
// WASM Loading
// ============================================================================

let modulePromise: Promise<LittleFSModule> | null = null;

async function loadModule(wasmURL?: string | URL): Promise<LittleFSModule> {
  if (modulePromise) return modulePromise;

  const url = wasmURL || new URL('./littlefs.wasm', import.meta.url);
  
  modulePromise = (async () => {
    const response = await fetch(url);
    const wasmBinary = await response.arrayBuffer();
    
    // Emscripten module factory - dynamically loaded at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createModule = (await import(/* webpackIgnore: true */ './littlefs.js' as any)).default as (
      config?: { wasmBinary?: ArrayBuffer; noInitialRun?: boolean }
    ) => Promise<LittleFSModule>;
    
    return createModule({
      wasmBinary,
      noInitialRun: true,
    });
  })();

  return modulePromise;
}

// ============================================================================
// Helper Functions
// ============================================================================

function allocString(module: LittleFSModule, str: string): number {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str + '\0');
  const ptr = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function allocBuffer(module: LittleFSModule, data: Uint8Array): number {
  const ptr = module._malloc(data.length);
  module.HEAPU8.set(data, ptr);
  return ptr;
}

// ============================================================================
// LittleFS Implementation
// ============================================================================

class LittleFSImpl implements LittleFS {
  constructor(private module: LittleFSModule) {}

  format(): void {
    checkError(this.module._lfs_wasm_format(), 'format');
    checkError(this.module._lfs_wasm_mount(), 'mount after format');
  }

  list(basePath: string = '/'): LittleFSEntry[] {
    const entries: LittleFSEntry[] = [];
    this.listRecursive(basePath, entries);
    return entries;
  }

  private listRecursive(dirPath: string, entries: LittleFSEntry[]): void {
    const pathPtr = allocString(this.module, dirPath);
    const namePtr = this.module._malloc(256);
    const typePtr = this.module._malloc(4);
    const sizePtr = this.module._malloc(4);

    try {
      const handle = this.module._lfs_wasm_dir_open(pathPtr);
      if (handle < 0) {
        checkError(handle, `open directory '${dirPath}'`);
      }

      try {
        while (true) {
          const res = this.module._lfs_wasm_dir_read(handle, namePtr, 256, typePtr, sizePtr);
          if (res <= 0) break;

          const nameBytes: number[] = [];
          for (let i = 0; i < 256; i++) {
            const byte = this.module.HEAPU8[namePtr + i];
            if (byte === 0) break;
            nameBytes.push(byte);
          }
          const name = new TextDecoder().decode(new Uint8Array(nameBytes));
          const type = this.module.HEAP32[typePtr >> 2];
          const size = this.module.HEAPU32[sizePtr >> 2];

          const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
          
          if (type === 2) {
            // Directory - recurse
            entries.push({ path: fullPath, size: 0, type: 'dir' });
            this.listRecursive(fullPath, entries);
          } else {
            entries.push({ path: fullPath, size, type: 'file' });
          }
        }
      } finally {
        this.module._lfs_wasm_dir_close(handle);
      }
    } finally {
      this.module._free(pathPtr);
      this.module._free(namePtr);
      this.module._free(typePtr);
      this.module._free(sizePtr);
    }
  }

  addFile(path: string, data: FileSource): void {
    this.writeFile(path, data);
  }

  writeFile(path: string, data: FileSource): void {
    const bytes = toUint8Array(data);
    const pathPtr = allocString(this.module, path);
    const dataPtr = allocBuffer(this.module, bytes);

    try {
      checkError(
        this.module._lfs_wasm_write_file(pathPtr, dataPtr, bytes.length),
        `write file '${path}'`
      );
    } finally {
      this.module._free(pathPtr);
      this.module._free(dataPtr);
    }
  }

  readFile(path: string): Uint8Array {
    const pathPtr = allocString(this.module, path);

    try {
      // First get file size
      const size = this.module._lfs_wasm_file_size(pathPtr);
      checkError(size, `stat file '${path}'`);

      if (size === 0) {
        return new Uint8Array(0);
      }

      // Allocate buffer and read
      const outPtr = this.module._malloc(size);
      try {
        const bytesRead = this.module._lfs_wasm_read_file(pathPtr, outPtr, size);
        checkError(bytesRead, `read file '${path}'`);

        // Copy data out
        const result = new Uint8Array(bytesRead);
        result.set(this.module.HEAPU8.subarray(outPtr, outPtr + bytesRead));
        return result;
      } finally {
        this.module._free(outPtr);
      }
    } finally {
      this.module._free(pathPtr);
    }
  }

  deleteFile(path: string): void {
    this.delete(path);
  }

  delete(path: string, options?: { recursive?: boolean }): void {
    if (options?.recursive) {
      // List all entries and delete from deepest first
      const entries = this.list(path);
      entries.sort((a, b) => b.path.length - a.path.length);
      
      for (const entry of entries) {
        const ptr = allocString(this.module, entry.path);
        try {
          this.module._lfs_wasm_remove(ptr);
        } finally {
          this.module._free(ptr);
        }
      }
    }

    const pathPtr = allocString(this.module, path);
    try {
      checkError(this.module._lfs_wasm_remove(pathPtr), `delete '${path}'`);
    } finally {
      this.module._free(pathPtr);
    }
  }

  mkdir(path: string): void {
    const pathPtr = allocString(this.module, path);
    try {
      const err = this.module._lfs_wasm_mkdir(pathPtr);
      // Ignore "already exists" error
      if (err !== 0 && err !== -4) {
        checkError(err, `mkdir '${path}'`);
      }
    } finally {
      this.module._free(pathPtr);
    }
  }

  rename(oldPath: string, newPath: string): void {
    const oldPtr = allocString(this.module, oldPath);
    const newPtr = allocString(this.module, newPath);
    try {
      checkError(
        this.module._lfs_wasm_rename(oldPtr, newPtr),
        `rename '${oldPath}' to '${newPath}'`
      );
    } finally {
      this.module._free(oldPtr);
      this.module._free(newPtr);
    }
  }

  toImage(): Uint8Array {
    const ptr = this.module._lfs_wasm_get_image();
    const size = this.module._lfs_wasm_get_image_size();
    
    // Copy the data (don't return a view into WASM memory)
    const result = new Uint8Array(size);
    result.set(this.module.HEAPU8.subarray(ptr, ptr + size));
    return result;
  }

  getUsage(): { used: number; total: number; free: number } {
    const usedPtr = this.module._malloc(4);
    const totalPtr = this.module._malloc(4);

    try {
      checkError(this.module._lfs_wasm_fs_stat(usedPtr, totalPtr), 'get usage');
      
      const used = this.module.HEAPU32[usedPtr >> 2];
      const total = this.module.HEAPU32[totalPtr >> 2];
      
      return {
        used,
        total,
        free: total - used,
      };
    } finally {
      this.module._free(usedPtr);
      this.module._free(totalPtr);
    }
  }

  getDiskVersion(): number {
    const versionPtr = this.module._malloc(4);
    try {
      checkError(this.module._lfs_wasm_get_fs_info(versionPtr), 'get disk version');
      return this.module.HEAPU32[versionPtr >> 2];
    } finally {
      this.module._free(versionPtr);
    }
  }

  destroy(): void {
    this.module._lfs_wasm_cleanup();
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function createLittleFS(options: LittleFSOptions = {}): Promise<LittleFS> {
  const module = await loadModule(options.wasmURL);
  
  const blockSize = options.blockSize ?? 4096;
  const blockCount = options.blockCount ?? 256;
  const lookahead = options.lookaheadSize ?? 32;

  // Set disk version before init if specified
  // This prevents automatic migration of older filesystems
  if (options.diskVersion !== undefined) {
    module._lfs_wasm_set_disk_version(options.diskVersion);
  }

  checkError(module._lfs_wasm_init(blockSize, blockCount, lookahead), 'init');
  
  if (options.formatOnInit) {
    checkError(module._lfs_wasm_format(), 'format');
  }
  
  checkError(module._lfs_wasm_mount(), 'mount');

  return new LittleFSImpl(module);
}

export async function createLittleFSFromImage(
  image: BinarySource,
  options: LittleFSOptions = {}
): Promise<LittleFS> {
  const module = await loadModule(options.wasmURL);
  
  const imageData = image instanceof ArrayBuffer ? new Uint8Array(image) : image;
  const imagePtr = allocBuffer(module, imageData);
  
  try {
    checkError(
      module._lfs_wasm_init_from_image(imagePtr, imageData.length, options.blockSize ?? 0),
      'init from image'
    );
  } finally {
    module._free(imagePtr);
  }
  
  checkError(module._lfs_wasm_mount(), 'mount');

  return new LittleFSImpl(module);
}

// Re-export types
export type { FileSource, BinarySource } from '../shared/types';
