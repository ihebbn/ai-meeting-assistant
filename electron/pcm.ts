/**
 * Normalise PCM received over IPC to a Float32Array.
 * Preferred input is a Float32Array (structured clone, no per-sample copying in JS);
 * ArrayBuffer and plain number[] are accepted for compatibility.
 */
export function toFloat32Pcm(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    const usableBytes = value.byteLength - (value.byteLength % Float32Array.BYTES_PER_ELEMENT);
    return new Float32Array(value.slice(0, usableBytes));
  }
  if (Array.isArray(value)) {
    const out = new Float32Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = Number(value[i]) || 0;
    }
    return out;
  }
  return new Float32Array(0);
}
