/**
 * Shared types for filesystem modules
 */

export type FileSource = string | ArrayBuffer | Uint8Array;
export type BinarySource = ArrayBuffer | Uint8Array;

export function toUint8Array(data: FileSource): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return data;
}
