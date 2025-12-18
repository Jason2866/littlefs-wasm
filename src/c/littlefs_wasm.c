/**
 * LittleFS WASM Glue Code
 * 
 * This file provides a RAM-backed block device for LittleFS and exports
 * functions to be called from JavaScript via WebAssembly.
 * 
 * Compile with Emscripten:
 *   emcc src/c/littlefs_wasm.c third_party/littlefs/lfs.c third_party/littlefs/lfs_util.c \
 *        -I third_party/littlefs -o dist/littlefs/littlefs.js \
 *        -s WASM=1 -s EXPORTED_FUNCTIONS=[...] -s MODULARIZE=1 ...
 */

#include "lfs.h"
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// ============================================================================
// Configuration - ESP-IDF compatible
// ============================================================================

// IMPORTANT: Compile flags required for ESP-IDF compatibility:
//   -DLFS_MULTIVERSION           Enable disk version control
//   -DLFS_NAME_MAX=64            ESP-IDF default filename length
//   -DLFS_ATTR_MAX=4             File metadata for timestamps

#define DEFAULT_BLOCK_SIZE    4096
#define DEFAULT_BLOCK_COUNT   256    // 1 MiB default
#define DEFAULT_LOOKAHEAD     32

// Use LFS_NAME_MAX from compile flags, or default to ESP-IDF value
#ifndef LFS_NAME_MAX
#define LFS_NAME_MAX          64     // ESP-IDF default
#endif

#define MAX_PATH_LENGTH       (LFS_NAME_MAX * 4)  // Allow nested paths
#define MAX_FILES             16

// Default disk version: 0 = auto-detect from image (supports v2.0 and v2.1)
#define DEFAULT_DISK_VERSION  0

// ============================================================================
// RAM Block Device
// ============================================================================

static uint8_t *ram_storage = NULL;
static uint32_t storage_size = 0;
static uint32_t block_size = DEFAULT_BLOCK_SIZE;
static uint32_t block_count = DEFAULT_BLOCK_COUNT;
static uint32_t disk_version = DEFAULT_DISK_VERSION;

// LittleFS instance
static lfs_t lfs;
static struct lfs_config cfg;
static int mounted = 0;

// File handles for open files
static lfs_file_t open_files[MAX_FILES];
static int file_in_use[MAX_FILES];

// Directory handles - separate from files because lfs_dir_t != lfs_file_t
#define MAX_DIRS 8
static lfs_dir_t open_dirs[MAX_DIRS];
static int dir_in_use[MAX_DIRS];

// ============================================================================
// Block Device Operations
// ============================================================================

static int ram_read(const struct lfs_config *c, lfs_block_t block,
                    lfs_off_t off, void *buffer, lfs_size_t size) {
    if (!ram_storage) return LFS_ERR_IO;
    uint32_t addr = block * c->block_size + off;
    if (addr + size > storage_size) return LFS_ERR_IO;
    memcpy(buffer, ram_storage + addr, size);
    return 0;
}

static int ram_prog(const struct lfs_config *c, lfs_block_t block,
                    lfs_off_t off, const void *buffer, lfs_size_t size) {
    if (!ram_storage) return LFS_ERR_IO;
    uint32_t addr = block * c->block_size + off;
    if (addr + size > storage_size) return LFS_ERR_IO;
    memcpy(ram_storage + addr, buffer, size);
    return 0;
}

static int ram_erase(const struct lfs_config *c, lfs_block_t block) {
    if (!ram_storage) return LFS_ERR_IO;
    uint32_t addr = block * c->block_size;
    if (addr + c->block_size > storage_size) return LFS_ERR_IO;
    // NOR flash erases to 0xFF
    memset(ram_storage + addr, 0xFF, c->block_size);
    return 0;
}

static int ram_sync(const struct lfs_config *c) {
    (void)c;
    return 0;
}

// ============================================================================
// Exported Functions (called from JavaScript)
// ============================================================================

/**
 * Set the disk version for new filesystems
 * @param version Disk version (e.g., 0x00020000 for v2.0, 0x00020001 for v2.1)
 *                Use 0 for latest version
 */
void lfs_wasm_set_disk_version(uint32_t version) {
    disk_version = version;
}

/**
 * Get the current disk version setting
 * @return Current disk version
 */
uint32_t lfs_wasm_get_disk_version(void) {
    return disk_version;
}

/**
 * Initialize the filesystem with given parameters
 * @param blk_size Block size in bytes (default 4096)
 * @param blk_count Number of blocks
 * @param lookahead Lookahead buffer size
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_init(uint32_t blk_size, uint32_t blk_count, uint32_t lookahead) {
    // Free existing storage if any
    if (ram_storage) {
        if (mounted) {
            lfs_unmount(&lfs);
            mounted = 0;
        }
        free(ram_storage);
        ram_storage = NULL;
    }

    // Use defaults if zero
    block_size = blk_size > 0 ? blk_size : DEFAULT_BLOCK_SIZE;
    block_count = blk_count > 0 ? blk_count : DEFAULT_BLOCK_COUNT;
    uint32_t la_size = lookahead > 0 ? lookahead : DEFAULT_LOOKAHEAD;

    storage_size = block_size * block_count;
    ram_storage = (uint8_t *)malloc(storage_size);
    if (!ram_storage) return LFS_ERR_NOMEM;

    // Initialize to 0xFF (NOR flash erased state)
    memset(ram_storage, 0xFF, storage_size);

    // Initialize file and directory handles
    memset(file_in_use, 0, sizeof(file_in_use));
    memset(dir_in_use, 0, sizeof(dir_in_use));

    // Configure LittleFS
    memset(&cfg, 0, sizeof(cfg));
    cfg.read = ram_read;
    cfg.prog = ram_prog;
    cfg.erase = ram_erase;
    cfg.sync = ram_sync;
    cfg.read_size = 1;
    cfg.prog_size = 1;
    cfg.block_size = block_size;
    cfg.block_count = block_count;
    cfg.cache_size = block_size;
    cfg.lookahead_size = la_size;
    cfg.block_cycles = 500;
    cfg.name_max = LFS_NAME_MAX;  // ESP-IDF uses 64
    cfg.file_max = 0;             // Use default
    cfg.attr_max = 0;             // Use default
#ifdef LFS_MULTIVERSION
    cfg.disk_version = 0;  // 0 = auto-detect version from image (supports v2.0 and v2.1)
#endif

    return 0;
}

/**
 * Initialize from an existing image
 * @param image Pointer to the image data
 * @param image_size Size of the image in bytes
 * @param blk_size Block size (0 = auto-detect from image size)
 * @param blk_count Number of blocks (0 = calculate from image_size/blk_size)
 * @param lookahead Lookahead buffer size (0 = use default)
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_init_from_image(uint8_t *image, uint32_t image_size, uint32_t blk_size, uint32_t blk_count, uint32_t lookahead) {
    // Free existing storage
    if (ram_storage) {
        if (mounted) {
            lfs_unmount(&lfs);
            mounted = 0;
        }
        free(ram_storage);
        ram_storage = NULL;
    }

    // Determine block size
    block_size = blk_size > 0 ? blk_size : DEFAULT_BLOCK_SIZE;
    
    // Determine block count
    if (blk_count > 0) {
        block_count = blk_count;
    } else {
        block_count = image_size / block_size;
    }
    
    storage_size = block_size * block_count;
    
    // Use lookahead or default
    uint32_t la_size = lookahead > 0 ? lookahead : DEFAULT_LOOKAHEAD;

    if (storage_size == 0 || block_count == 0) {
        return LFS_ERR_INVAL;
    }

    ram_storage = (uint8_t *)malloc(storage_size);
    if (!ram_storage) return LFS_ERR_NOMEM;

    // Copy image data (only up to image_size, not storage_size which might be larger)
    uint32_t copy_size = image_size < storage_size ? image_size : storage_size;
    memcpy(ram_storage, image, copy_size);
    
    // Fill rest with 0xFF if image is smaller than storage
    if (copy_size < storage_size) {
        memset(ram_storage + copy_size, 0xFF, storage_size - copy_size);
    }

    // Initialize file and directory handles
    memset(file_in_use, 0, sizeof(file_in_use));
    memset(dir_in_use, 0, sizeof(dir_in_use));

    // Configure LittleFS
    memset(&cfg, 0, sizeof(cfg));
    cfg.read = ram_read;
    cfg.prog = ram_prog;
    cfg.erase = ram_erase;
    cfg.sync = ram_sync;
    cfg.read_size = 1;
    cfg.prog_size = 1;
    cfg.block_size = block_size;
    cfg.block_count = block_count;
    cfg.cache_size = block_size;
    cfg.lookahead_size = la_size;
    cfg.block_cycles = 500;
    cfg.name_max = LFS_NAME_MAX;  // ESP-IDF uses 64
    cfg.file_max = 0;             // Use default
    cfg.attr_max = 0;             // Use default
#ifdef LFS_MULTIVERSION
    cfg.disk_version = 0;  // 0 = auto-detect version from image (supports v2.0 and v2.1)
#endif

    return 0;
}

/**
 * Get the filesystem info including disk version
 * Must be called after mount
 * @param version_out Pointer to store disk version
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_get_fs_info(uint32_t *version_out) {
    if (!mounted) return LFS_ERR_INVAL;
    
    struct lfs_fsinfo fsinfo;
    int err = lfs_fs_stat(&lfs, &fsinfo);
    if (err < 0) return err;
    
    if (version_out) {
        *version_out = fsinfo.disk_version;
    }
    return 0;
}

/**
 * Mount the filesystem
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_mount(void) {
    if (!ram_storage) return LFS_ERR_INVAL;
    if (mounted) return 0;

    int err = lfs_mount(&lfs, &cfg);
    if (err == 0) {
        mounted = 1;
    }
    return err;
}

/**
 * Unmount the filesystem
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_unmount(void) {
    if (!mounted) return 0;
    int err = lfs_unmount(&lfs);
    if (err == 0) {
        mounted = 0;
    }
    return err;
}

/**
 * Format the filesystem
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_format(void) {
    if (!ram_storage) return LFS_ERR_INVAL;
    
    if (mounted) {
        lfs_unmount(&lfs);
        mounted = 0;
    }
    
    return lfs_format(&lfs, &cfg);
}

/**
 * Create a directory
 * @param path Directory path
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_mkdir(const char *path) {
    if (!mounted) return LFS_ERR_INVAL;
    return lfs_mkdir(&lfs, path);
}

/**
 * Remove a file or empty directory
 * @param path Path to remove
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_remove(const char *path) {
    if (!mounted) return LFS_ERR_INVAL;
    return lfs_remove(&lfs, path);
}

/**
 * Rename a file or directory
 * @param oldpath Current path
 * @param newpath New path
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_rename(const char *oldpath, const char *newpath) {
    if (!mounted) return LFS_ERR_INVAL;
    return lfs_rename(&lfs, oldpath, newpath);
}

/**
 * Get file/directory info
 * @param path Path to query
 * @param out_type Output: 1 for file, 2 for directory
 * @param out_size Output: size in bytes (for files)
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_stat(const char *path, int *out_type, uint32_t *out_size) {
    if (!mounted) return LFS_ERR_INVAL;
    
    struct lfs_info info;
    int err = lfs_stat(&lfs, path, &info);
    if (err < 0) return err;
    
    *out_type = (info.type == LFS_TYPE_DIR) ? 2 : 1;
    *out_size = info.size;
    return 0;
}

/**
 * Open a directory for reading
 * @param path Directory path
 * @return Handle (>= 0) on success, negative error code on failure
 */
int lfs_wasm_dir_open(const char *path) {
    if (!mounted) return LFS_ERR_INVAL;
    
    // Find a free directory slot
    int slot = -1;
    for (int i = 0; i < MAX_DIRS; i++) {
        if (!dir_in_use[i]) {
            slot = i;
            break;
        }
    }
    if (slot < 0) return LFS_ERR_NOMEM;
    
    int err = lfs_dir_open(&lfs, &open_dirs[slot], path);
    if (err < 0) return err;
    
    dir_in_use[slot] = 1;
    return slot;
}

/**
 * Read next directory entry
 * @param handle Directory handle from lfs_wasm_dir_open
 * @param out_name Buffer for entry name
 * @param out_name_len Size of name buffer
 * @param out_type Output: 1 for file, 2 for directory
 * @param out_size Output: size in bytes
 * @return 1 if entry read, 0 if end of directory, negative on error
 */
int lfs_wasm_dir_read(int handle, char *out_name, int out_name_len, 
                       int *out_type, uint32_t *out_size) {
    if (handle < 0 || handle >= MAX_DIRS || !dir_in_use[handle]) {
        return LFS_ERR_INVAL;
    }
    
    struct lfs_info info;
    
    int res = lfs_dir_read(&lfs, &open_dirs[handle], &info);
    if (res <= 0) return res;
    
    // Skip . and ..
    if (strcmp(info.name, ".") == 0 || strcmp(info.name, "..") == 0) {
        return lfs_wasm_dir_read(handle, out_name, out_name_len, out_type, out_size);
    }
    
    strncpy(out_name, info.name, out_name_len - 1);
    out_name[out_name_len - 1] = '\0';
    *out_type = (info.type == LFS_TYPE_DIR) ? 2 : 1;
    *out_size = info.size;
    
    return 1;
}

/**
 * Close a directory
 * @param handle Directory handle
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_dir_close(int handle) {
    if (handle < 0 || handle >= MAX_DIRS || !dir_in_use[handle]) {
        return LFS_ERR_INVAL;
    }
    
    int err = lfs_dir_close(&lfs, &open_dirs[handle]);
    dir_in_use[handle] = 0;
    return err;
}

/**
 * Write a file (creates parent directories if needed)
 * @param path File path
 * @param data File data
 * @param size Data size in bytes
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_write_file(const char *path, const uint8_t *data, uint32_t size) {
    if (!mounted) return LFS_ERR_INVAL;
    
    // Create parent directories
    char dir_path[MAX_PATH_LENGTH];
    strncpy(dir_path, path, MAX_PATH_LENGTH - 1);
    dir_path[MAX_PATH_LENGTH - 1] = '\0';
    
    for (char *p = dir_path + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            lfs_mkdir(&lfs, dir_path); // Ignore errors (may already exist)
            *p = '/';
        }
    }
    
    lfs_file_t file;
    int err = lfs_file_open(&lfs, &file, path, 
                            LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC);
    if (err < 0) return err;
    
    lfs_ssize_t written = lfs_file_write(&lfs, &file, data, size);
    lfs_file_close(&lfs, &file);
    
    if (written < 0) return written;
    if ((uint32_t)written != size) return LFS_ERR_IO;
    
    return 0;
}

/**
 * Read a file
 * @param path File path
 * @param out_data Output buffer (caller allocates)
 * @param max_size Maximum bytes to read
 * @return Number of bytes read, or negative error code
 */
int lfs_wasm_read_file(const char *path, uint8_t *out_data, uint32_t max_size) {
    if (!mounted) return LFS_ERR_INVAL;
    
    lfs_file_t file;
    int err = lfs_file_open(&lfs, &file, path, LFS_O_RDONLY);
    if (err < 0) return err;
    
    lfs_ssize_t read = lfs_file_read(&lfs, &file, out_data, max_size);
    lfs_file_close(&lfs, &file);
    
    return read;
}

/**
 * Get the size of a file
 * @param path File path
 * @return File size in bytes, or negative error code
 */
int lfs_wasm_file_size(const char *path) {
    if (!mounted) return LFS_ERR_INVAL;
    
    struct lfs_info info;
    int err = lfs_stat(&lfs, path, &info);
    if (err < 0) return err;
    
    return info.size;
}

/**
 * Get the raw filesystem image
 * @return Pointer to the image data
 */
uint8_t* lfs_wasm_get_image(void) {
    return ram_storage;
}

/**
 * Get the filesystem image size
 * @return Size in bytes
 */
uint32_t lfs_wasm_get_image_size(void) {
    return storage_size;
}

/**
 * Get filesystem usage statistics
 * @param out_used Output: blocks used
 * @param out_total Output: total blocks
 * @return 0 on success, negative error code on failure
 */
int lfs_wasm_fs_stat(uint32_t *out_used, uint32_t *out_total) {
    if (!mounted) return LFS_ERR_INVAL;
    
    lfs_ssize_t used = lfs_fs_size(&lfs);
    if (used < 0) return used;
    
    *out_used = used;
    *out_total = block_count;
    return 0;
}

/**
 * Clean up and free all resources
 */
void lfs_wasm_cleanup(void) {
    if (mounted) {
        lfs_unmount(&lfs);
        mounted = 0;
    }
    if (ram_storage) {
        free(ram_storage);
        ram_storage = NULL;
    }
    storage_size = 0;
}
