/**
 * Minimal WAV synthesis for the demo.
 *
 * The real server on the other end of this protocol was a GPU text-to-speech
 * service. Standing that up to demonstrate a transport is absurd, so the demo
 * sends tones instead — one note per frame, ascending. That choice is not
 * cosmetic: an ascending scale makes a reordering bug *audible*. Turn
 * reassembly off in the browser demo and you hear the scale come out scrambled.
 */

export const SAMPLE_RATE = 24_000;

/** One octave of a C major scale, in Hz. */
export const SCALE = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];

/** A sine tone with short attack and release, so frames do not click. */
export function tone(frequency: number, seconds: number): Float32Array {
  const length = Math.floor(seconds * SAMPLE_RATE);
  const samples = new Float32Array(length);
  const ramp = Math.floor(0.008 * SAMPLE_RATE);

  for (let i = 0; i < length; i++) {
    let gain = 0.25;
    if (i < ramp) gain *= i / ramp;
    else if (i > length - ramp) gain *= (length - i) / ramp;
    samples[i] = gain * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  }
  return samples;
}

/** Encode mono float samples as a self-contained 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 0x7fff), true);
  }

  return new Uint8Array(buffer);
}

/** Read duration out of a WAV header, so the CLI can report what it received. */
export function wavDurationSeconds(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const dataBytes = view.getUint32(40, true);
  return byteRate > 0 ? dataBytes / byteRate : dataBytes / (sampleRate * 2);
}
