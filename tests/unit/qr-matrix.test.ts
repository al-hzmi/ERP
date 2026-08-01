import { describe, expect, it } from 'vitest';
import { encodeQr, qrToSvgPath } from '@/lib/domain/zatca/qr-matrix';

/**
 * The QR encoder.
 *
 * A QR code that renders but does not scan is worse than no QR code: it looks finished and
 * fails in the customer's hand. So the load-bearing test here is the last block, which reads
 * the matrix back — undoing the mask, walking the data placement in reverse, and recovering the
 * original bytes. It fails on every mistake that produces a plausible-looking square: a wrong
 * mask, a misplaced format block, a reversed bit order, an off-by-one in the column walk.
 *
 * The structural tests above it are cheaper and catch the same class of error earlier, which is
 * why both exist.
 */

const ZATCA_TAGS_1_TO_6 =
  'ATHYtNix2YPYqSDYp9mE2KPZgdmCAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMDMtMTVUMDk6MzA6MDBaBAcxMTUwLjAwBQYxNTAuMDAGLGZuVlBzK2lnSHZkRU8xRjg1a3FuNjRyRjRHSWlPZXRTeEFSekxJMkdMalU9';

describe('structure', () => {
  it('sizes the matrix as 4 x version + 17', () => {
    const matrix = encodeQr('HELLO');
    expect(matrix.size).toBe(matrix.version * 4 + 17);
  });

  it('grows the version with the payload rather than truncating', () => {
    const small = encodeQr('x');
    const large = encodeQr('x'.repeat(600));
    expect(large.version).toBeGreaterThan(small.version);
    expect(large.size).toBeGreaterThan(small.size);
  });

  it('fits a full nine-tag ZATCA payload', () => {
    // Tags 1–9 run to roughly 480 bytes. If this ever throws, the version tables are wrong.
    const matrix = encodeQr('A'.repeat(520));
    expect(matrix.version).toBeLessThanOrEqual(40);
  });

  it('refuses a payload no QR code can hold, instead of emitting a broken one', () => {
    expect(() => encodeQr('x'.repeat(5000))).toThrow(/exceeds QR version 40/);
  });

  it('places the three finder patterns', () => {
    const { modules, size } = encodeQr(ZATCA_TAGS_1_TO_6);

    for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      // The 7x7 finder: dark ring, light ring, 3x3 dark core.
      expect(modules[row]![col]).toBe(true);
      expect(modules[row + 1]![col + 1]).toBe(false);
      expect(modules[row + 3]![col + 3]).toBe(true);
      expect(modules[row + 6]![col + 6]).toBe(true);
    }
  });

  it('places the timing patterns as alternating runs', () => {
    const { modules, size } = encodeQr(ZATCA_TAGS_1_TO_6);

    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('sets the dark module, which is dark in every valid code ever made', () => {
    const { modules, size } = encodeQr('anything');
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('is deterministic', () => {
    // Same input, same code. A mask chosen by anything but the penalty score would not be.
    const a = encodeQr(ZATCA_TAGS_1_TO_6);
    const b = encodeQr(ZATCA_TAGS_1_TO_6);
    expect(JSON.stringify(a.modules)).toBe(JSON.stringify(b.modules));
  });
});

describe('SVG rendering', () => {
  it('adds the four-module quiet zone scanners need', () => {
    const matrix = encodeQr('HELLO');
    const { extent } = qrToSvgPath(matrix);
    expect(extent).toBe(matrix.size + 8);
  });

  it('emits one rectangle per dark module and nothing for light ones', () => {
    const matrix = encodeQr('HELLO');
    const { path } = qrToSvgPath(matrix);
    const dark = matrix.modules.flat().filter(Boolean).length;
    expect((path.match(/M/g) ?? []).length).toBe(dark);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The decoder: the only test that proves the code is readable
// ─────────────────────────────────────────────────────────────────────────────

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

/** Rebuilds the function-module map exactly as the encoder does, independently of it. */
function functionMap(version: number, size: number): boolean[][] {
  const fixed: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) fixed[r]![c] = true;
  };

  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(row + r, col + c);
  }

  const centres = ALIGNMENT[version] ?? [];
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) mark(row + r, col + c);
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  mark(size - 8, 8);

  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }

  return fixed;
}

/**
 * Reads the mask number back out of the format information.
 *
 * The mask is *not* in the low bits. The 15-bit format word is `data << 10 | bch`, where data
 * is two EC-level bits followed by three mask bits — so the mask sits at bits 12..10, and the
 * BCH remainder occupies 9..0. Reading the bottom three bits gives part of the error-correction
 * remainder, which is uncorrelated noise that happens to be three bits wide.
 *
 * Bits 9..14 are written up the left column as `grid[14 - i][8]`, so bit 10 is at row 4, bit 11
 * at row 3 and bit 12 at row 2.
 */
function readMask(modules: readonly (readonly boolean[])[]): number {
  const raw =
    ((modules[4]![8] ? 1 : 0) << 0) |
    ((modules[3]![8] ? 1 : 0) << 1) |
    ((modules[2]![8] ? 1 : 0) << 2);

  // The same three bits of the fixed XOR pattern 0b101010000010010.
  const patternBits = (0b101010000010010 >>> 10) & 0b111;
  return raw ^ patternBits;
}

/** Undoes the mask and walks the data placement backwards to recover the codewords. */
function readCodewords(matrix: ReturnType<typeof encodeQr>): number[] {
  const { modules, size, version } = matrix;
  const fixed = functionMap(version, size);
  const mask = readMask(modules);

  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (fixed[row]![col]) continue;
        const value = modules[row]![col]!;
        bits.push((value !== maskAt(mask, row, col)) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    bytes.push(byte);
  }
  return bytes;
}

/**
 * De-interleaves the codewords and reads the byte-mode payload.
 *
 * Only the data half is needed — the error-correction blocks are not decoded, because the point
 * of the test is that the *encoder* laid the data down correctly, not that Reed–Solomon can
 * repair it.
 */
function decode(matrix: ReturnType<typeof encodeQr>): string {
  const EC_M: [number, number, number][] = [
    [0, 0, 0], [10, 1, 0], [16, 1, 0], [26, 1, 0], [18, 2, 0], [24, 2, 0], [16, 4, 0],
    [18, 4, 0], [22, 2, 2], [22, 3, 2], [26, 4, 1], [30, 1, 4], [22, 6, 2], [22, 8, 1],
    [24, 4, 5], [24, 5, 5], [28, 7, 3], [28, 10, 1], [26, 9, 4], [26, 3, 11], [26, 3, 13],
  ];
  const TOTAL = [
    0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901,
    991, 1085,
  ];

  const [ecPerBlock, g1, g2] = EC_M[matrix.version]!;
  const blockCount = g1 + g2;
  const capacity = TOTAL[matrix.version]! - ecPerBlock * blockCount;
  const g1Size = Math.floor(capacity / blockCount);

  const sizes = Array.from({ length: blockCount }, (_, i) => (i < g1 ? g1Size : g1Size + 1));
  const raw = readCodewords(matrix);

  // Undo the interleave.
  const blocks: number[][] = sizes.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...sizes); i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      if (i < sizes[b]!) blocks[b]!.push(raw[index++]!);
    }
  }

  const data = blocks.flat();
  const lengthBits = matrix.version < 10 ? 8 : 16;

  // Mode nibble, then the length, then the payload — all bit-aligned, so read bit by bit.
  const bits: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);

  const take = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | bits.shift()!;
    return value;
  };

  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`Expected byte mode, read ${mode.toString(2)}`);

  const length = take(lengthBits);
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) out.push(take(8));

  return new TextDecoder().decode(Uint8Array.from(out));
}

describe('round trip', () => {
  it('reads back a short ASCII payload', () => {
    expect(decode(encodeQr('HELLO WORLD'))).toBe('HELLO WORLD');
  });

  it('reads back a real ZATCA TLV payload', () => {
    // The thing that actually goes on an invoice. A code that fails here fails in a
    // customer's hand, which is where it would otherwise be discovered.
    expect(decode(encodeQr(ZATCA_TAGS_1_TO_6))).toBe(ZATCA_TAGS_1_TO_6);
  });

  it('reads back UTF-8, not just ASCII', () => {
    const arabic = 'شركة الأفق المتحدة للتجارة';
    expect(decode(encodeQr(arabic))).toBe(arabic);
  });

  it('reads back payloads across several versions', () => {
    for (const length of [1, 20, 100, 200, 300]) {
      const payload = 'Z'.repeat(length);
      expect(decode(encodeQr(payload))).toBe(payload);
    }
  });

  it('reads back a payload that needs a multi-block version', () => {
    // Version 5+ splits the data across blocks and interleaves them. A decoder that ignored
    // the interleave would pass every test above and fail this one.
    const payload = 'B'.repeat(150);
    const matrix = encodeQr(payload);
    expect(matrix.version).toBeGreaterThanOrEqual(6);
    expect(decode(matrix)).toBe(payload);
  });
});
