#!/usr/bin/env node
/**
 * Build script for LittleFS WebAssembly
 * 
 * Requires Emscripten SDK to be installed and activated:
 *   source /path/to/emsdk/emsdk_env.sh
 * 
 * Or install via Homebrew (macOS):
 *   brew install emscripten
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const vendorDir = join(rootDir, 'vendor', 'littlefs');
const srcDir = join(rootDir, 'src', 'c');
const buildDir = join(rootDir, 'build');
const distDir = join(rootDir, 'dist', 'wasm');

// Emscripten compiler settings
const EMCC_FLAGS = [
  // Optimization
  '-O3',
  '-flto',
  
  // LittleFS configuration - IMPORTANT: Enable multiversion support
  '-DLFS_MULTIVERSION',
  
  // Memory settings
  '-s', 'INITIAL_MEMORY=4194304',     // 4MB initial memory
  '-s', 'ALLOW_MEMORY_GROWTH=1',       // Allow growth
  '-s', 'MAXIMUM_MEMORY=67108864',     // 64MB max
  '-s', 'STACK_SIZE=65536',            // 64KB stack
  
  // Export settings
  '-s', 'MODULARIZE=1',
  '-s', 'EXPORT_NAME="createLittleFS"',
  '-s', 'ENVIRONMENT="web,worker"',
  '-s', 'FILESYSTEM=0',                 // We don't need Emscripten's FS
  '-s', 'NO_EXIT_RUNTIME=1',
  
  // Exported functions
  '-s', `EXPORTED_FUNCTIONS=[
    "_lfs_wasm_init",
    "_lfs_wasm_init_from_image",
    "_lfs_wasm_set_disk_version",
    "_lfs_wasm_get_disk_version",
    "_lfs_wasm_get_fs_info",
    "_lfs_wasm_mount",
    "_lfs_wasm_unmount",
    "_lfs_wasm_format",
    "_lfs_wasm_mkdir",
    "_lfs_wasm_remove",
    "_lfs_wasm_rename",
    "_lfs_wasm_stat",
    "_lfs_wasm_dir_open",
    "_lfs_wasm_dir_read",
    "_lfs_wasm_dir_close",
    "_lfs_wasm_write_file",
    "_lfs_wasm_read_file",
    "_lfs_wasm_file_size",
    "_lfs_wasm_get_image",
    "_lfs_wasm_get_image_size",
    "_lfs_wasm_fs_stat",
    "_lfs_wasm_cleanup",
    "_malloc",
    "_free"
  ]`.replace(/\s+/g, ''),
  
  // Runtime exports
  '-s', 'EXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPU32","HEAP32"]',
  
  // Debug settings (comment out for production)
  // '-s', 'ASSERTIONS=1',
  // '-g',
].join(' ');

// LittleFS source files (relative to vendor dir)
const LFS_SOURCES = [
  'lfs.c',
  'lfs_util.c',
];

function run(cmd, options = {}) {
  console.log(`> ${cmd}`);
  try {
    execSync(cmd, { 
      stdio: 'inherit', 
      cwd: options.cwd || rootDir,
      ...options 
    });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function checkEmscripten() {
  try {
    execSync('emcc --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function downloadLittleFS() {
  const version = process.env.LITTLEFS_VERSION || 'v2.9.3';
  const url = `https://github.com/littlefs-project/littlefs/archive/refs/tags/${version}.tar.gz`;
  const tarFile = join(buildDir, 'littlefs.tar.gz');
  
  console.log(`\n📦 Downloading LittleFS ${version}...`);
  
  // Create directories
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(dirname(vendorDir), { recursive: true });
  
  // Download
  run(`curl -L -o "${tarFile}" "${url}"`);
  
  // Extract
  run(`tar -xzf "${tarFile}" -C "${buildDir}"`);
  
  // Move to vendor dir
  const extractedDir = join(buildDir, `littlefs-${version.replace('v', '')}`);
  if (existsSync(vendorDir)) {
    rmSync(vendorDir, { recursive: true });
  }
  cpSync(extractedDir, vendorDir, { recursive: true });
  
  console.log('✅ LittleFS source downloaded');
}

function build() {
  console.log('\n🔨 Building LittleFS WASM...');
  
  // Check for Emscripten
  if (!checkEmscripten()) {
    console.error('❌ Emscripten not found!');
    console.error('Please install Emscripten SDK:');
    console.error('  https://emscripten.org/docs/getting_started/downloads.html');
    console.error('\nOr on macOS:');
    console.error('  brew install emscripten');
    process.exit(1);
  }
  
  // Check for LittleFS source
  if (!existsSync(join(vendorDir, 'lfs.c'))) {
    downloadLittleFS();
  }
  
  // Create output directories
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  
  // Build source list
  const sources = [
    join(srcDir, 'littlefs_wasm.c'),
    ...LFS_SOURCES.map(f => join(vendorDir, f)),
  ];
  
  // Include paths
  const includes = [
    `-I"${vendorDir}"`,
    `-I"${srcDir}"`,
  ];
  
  // Output files
  const jsOutput = join(distDir, 'littlefs.js');
  const wasmOutput = join(distDir, 'littlefs.wasm');
  
  // Build command
  const cmd = [
    'emcc',
    ...sources.map(s => `"${s}"`),
    ...includes,
    EMCC_FLAGS,
    '-o', `"${jsOutput}"`,
  ].join(' ');
  
  run(cmd);
  
  // Verify outputs
  if (!existsSync(jsOutput) || !existsSync(wasmOutput)) {
    console.error('❌ Build failed - output files not created');
    process.exit(1);
  }
  
  // Show file sizes
  const jsSize = (readFileSync(jsOutput).length / 1024).toFixed(1);
  const wasmSize = (readFileSync(wasmOutput).length / 1024).toFixed(1);
  
  console.log('\n✅ Build complete!');
  console.log(`   ${jsOutput} (${jsSize} KB)`);
  console.log(`   ${wasmOutput} (${wasmSize} KB)`);
}

function clean() {
  console.log('🧹 Cleaning...');
  
  if (existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true });
  }
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true });
  }
  
  console.log('✅ Clean complete');
}

// Parse command line args
const args = process.argv.slice(2);
const command = args[0] || 'build';

switch (command) {
  case 'build':
    build();
    break;
  case 'clean':
    clean();
    break;
  case 'download':
    downloadLittleFS();
    break;
  default:
    console.log('Usage: build-wasm.mjs [build|clean|download]');
    process.exit(1);
}
