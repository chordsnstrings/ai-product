/** Minimal types for heic-decode (libheif compiled to WASM; no native dependencies). */
declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel. */
    data: Uint8ClampedArray;
  }
  interface HeicFrame {
    /** Known from the container before any pixel is decoded. */
    width: number;
    height: number;
    decode(): Promise<DecodedImage>;
  }
  function decode(opts: { buffer: Uint8Array }): Promise<DecodedImage>;
  namespace decode {
    function all(opts: { buffer: Uint8Array }): Promise<HeicFrame[] & { dispose(): void }>;
  }
  export = decode;
}
