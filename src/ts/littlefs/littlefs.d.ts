/// <reference types="emscripten" />

declare module '*/littlefs.js' {
  interface LittleFSModule extends EmscriptenModule {
    _lfs_wasm_init(blockSize: number, blockCount: number, lookahead: number): number;
    _lfs_wasm_init_from_image(imagePtr: number, imageSize: number, blockSize: number): number;
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

  type ModuleFactory = (config?: Partial<EmscriptenModule>) => Promise<LittleFSModule>;
  
  const createModule: ModuleFactory;
  export default createModule;
}
