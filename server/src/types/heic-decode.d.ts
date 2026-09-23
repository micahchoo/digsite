// heic-decode 2.1 ships no types. Only what boards/camera.ts calls.
declare module 'heic-decode' {
  type Decoded = { width: number; height: number; data: Uint8ClampedArray };
  type Image = {
    width: number;
    height: number;
    decode: () => Promise<Decoded>;
  };
  function decode(input: { buffer: Uint8Array }): Promise<Decoded>;
  namespace decode {
    function all(input: {
      buffer: Uint8Array;
    }): Promise<Image[] & { dispose: () => void }>;
  }
  export default decode;
}
