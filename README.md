# LittleFS WebAssembly

Compile [LittleFS](https://github.com/littlefs-project/littlefs) to WebAssembly for use in browsers and Node.js.

This library provides a TypeScript-first API for creating, reading, and manipulating LittleFS filesystem images entirely in memory. Perfect for web-based tools that need to flash ESP32/ESP8266 devices with pre-populated filesystems.

## Features

- 🚀 **Pure WebAssembly** - No native dependencies
- 📦 **RAM-based** - All operations happen in memory
- 🔧 **TypeScript-first** - Full type definitions included
- 💾 **Image Export** - Export filesystem as binary for flashing
- 📁 **Full API** - Create files, directories, list, rename, delete
- 🌐 **Browser & Node.js** - Works in both environments

## Installation

```bash
npm install littlefs-wasm
```

## Quick Start

```typescript
import { createLittleFS } from 'littlefs-wasm';

// Create a new filesystem
const fs = await createLittleFS({
  blockSize: 4096,
  blockCount: 256,  // 1MB total
  formatOnInit: true,
});

// Write files
fs.writeFile('/config.json', JSON.stringify({ wifi: 'mynetwork' }));
fs.writeFile('/index.html', '<h1>Hello ESP!</h1>');

// Create directories
fs.mkdir('/data');
fs.writeFile('/data/log.txt', 'Boot successful\n');

// List all files
const entries = fs.list('/');
console.log(entries);
// [
//   { path: '/config.json', size: 24, type: 'file' },
//   { path: '/index.html', size: 19, type: 'file' },
//   { path: '/data', size: 0, type: 'dir' },
//   { path: '/data/log.txt', size: 17, type: 'file' }
// ]

// Export as binary image for flashing
const image = fs.toImage();
// Use with esptool or WebSerial to flash to device

// Clean up
fs.destroy();
```

## Disk Version Control

**IMPORTANT:** By default, LittleFS may migrate older filesystem versions (e.g., 2.0 → 2.1) when mounting. To prevent this, explicitly set the disk version:

```typescript
import { createLittleFS, DISK_VERSION_2_0, formatDiskVersion } from 'littlefs-wasm';

// Create filesystem with explicit v2.0 for compatibility
const fs = await createLittleFS({
  blockSize: 4096,
  blockCount: 256,
  formatOnInit: true,
  diskVersion: DISK_VERSION_2_0,  // Prevents migration to v2.1
});

// Check the disk version of a mounted filesystem
console.log('Disk version:', formatDiskVersion(fs.getDiskVersion()));
// Output: "Disk version: 2.0"
```

Available version constants:
- `DISK_VERSION_2_0` (0x00020000) - Compatible with older ESP implementations
- `DISK_VERSION_2_1` (0x00020001) - Latest version with additional features

## Loading Existing Images

```typescript
import { createLittleFSFromImage, formatDiskVersion } from 'littlefs-wasm';

// Load from file or network
const imageData = await fetch('/existing-littlefs.bin').then(r => r.arrayBuffer());

const fs = await createLittleFSFromImage(imageData, {
  blockSize: 4096,  // Must match original
});

// Check the disk version (will NOT be migrated automatically)
console.log('Image disk version:', formatDiskVersion(fs.getDiskVersion()));

// Read existing files
const config = fs.readFile('/config.json');
console.log(new TextDecoder().decode(config));

// Modify and re-export
fs.writeFile('/config.json', JSON.stringify({ wifi: 'newnetwork' }));
const newImage = fs.toImage();
```

## API Reference

### `createLittleFS(options?)`

Creates a new empty LittleFS instance.

```typescript
interface LittleFSOptions {
  blockSize?: number;     // Block size in bytes (default: 4096)
  blockCount?: number;    // Number of blocks (default: 256)
  lookaheadSize?: number; // Lookahead buffer size (default: 32)
  wasmURL?: string | URL; // Custom WASM file location
  formatOnInit?: boolean; // Format immediately (default: false)
}
```

### `createLittleFSFromImage(data, options?)`

Creates a LittleFS instance from an existing binary image.

### LittleFS Methods

```typescript
interface LittleFS {
  // Format the filesystem (erases all data)
  format(): void;

  // List all files and directories recursively
  list(path?: string): LittleFSEntry[];

  // Write a file (creates parent directories automatically)
  writeFile(path: string, data: FileSource): void;
  addFile(path: string, data: FileSource): void;  // Alias

  // Read a file
  readFile(path: string): Uint8Array;

  // Delete a file or empty directory
  deleteFile(path: string): void;
  delete(path: string, options?: { recursive?: boolean }): void;

  // Create a directory
  mkdir(path: string): void;

  // Rename/move a file or directory
  rename(oldPath: string, newPath: string): void;

  // Export filesystem as binary image
  toImage(): Uint8Array;

  // Get filesystem usage statistics
  getUsage(): { used: number; total: number; free: number };

  // Get the disk version of the mounted filesystem
  getDiskVersion(): number;

  // Free WASM resources
  destroy(): void;
}
```

### Data Types

```typescript
// Acceptable input for file content
type FileSource = 
  | string 
  | Uint8Array 
  | ArrayBuffer;

// Directory entry
interface LittleFSEntry {
  path: string;
  size: number;
  type: 'file' | 'dir';
}
```

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)

On macOS:
```bash
brew install emscripten
```

### Build Steps

```bash
# Clone repository
git clone https://github.com/yourusername/littlefs-wasm
cd littlefs-wasm

# Install dependencies
npm install

# Download LittleFS source (automated)
npm run build:wasm

# Build TypeScript
npm run build

# Run tests
npm test
```

### Manual WASM Build

```bash
# Download LittleFS
node scripts/build-wasm.mjs download

# Build WASM
node scripts/build-wasm.mjs build

# Clean build artifacts
node scripts/build-wasm.mjs clean
```

## Configuration for ESP Devices

Common block sizes and counts for ESP devices:

| Device | Flash Size | Block Size | Block Count |
|--------|------------|------------|-------------|
| ESP8266 | 1MB SPIFFS | 4096 | 256 |
| ESP8266 | 4MB | 4096 | 1024 |
| ESP32 | 4MB | 4096 | ~512* |
| ESP32-S3 | 8MB | 4096 | ~1024* |

*Actual partition size depends on your partition table.

## Using with ESPConnect/WebSerial

```typescript
import { createLittleFS } from 'littlefs-wasm';
import { ESPLoader } from 'esptool-js';

// Create filesystem image
const fs = await createLittleFS({ blockSize: 4096, blockCount: 512 });
fs.writeFile('/config.json', '{"device":"esp32"}');
const image = fs.toImage();
fs.destroy();

// Flash to device at littlefs partition offset
const transport = new Transport(serialPort);
const loader = new ESPLoader(transport, terminal);
await loader.main_fn();

const partitionOffset = 0x290000;  // Your LittleFS partition offset
await loader.flash_data(image, partitionOffset, () => {});
```

## Error Handling

All operations throw `LittleFSError` on failure:

```typescript
import { LittleFSError } from 'littlefs-wasm';

try {
  fs.readFile('/nonexistent.txt');
} catch (error) {
  if (error instanceof LittleFSError) {
    console.log(error.message);  // "read file '/nonexistent.txt': No such file or directory"
    console.log(error.code);     // -3
  }
}
```

## License

MIT License - see [LICENSE](LICENSE)

## Credits

- [littlefs](https://github.com/littlefs-project/littlefs) - The actual filesystem implementation
- [Emscripten](https://emscripten.org/) - WASM compiler toolchain
