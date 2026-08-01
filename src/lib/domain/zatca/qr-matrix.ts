/**
 * A QR Code encoder, byte mode, error correction level M.
 *
 * ## Why this is here rather than a dependency
 *
 * The printed invoice has to carry a scannable ZATCA QR, and nothing in the tree could draw
 * one. The alternatives were an npm package — which the artifact CSP and the offline-first
 * posture both argue against, and which would be a new runtime dependency for one screen — or
 * an image service, which puts the taxpayer's invoice totals through a third party. So it is
 * implemented: ISO/IEC 18004 is a fixed, published specification that will not change.
 *
 * ## Scope, stated so nobody assumes more
 *
 * Byte mode only, ECC level M, versions 1–40, mask patterns 0–7 with the standard penalty
 * evaluation. That covers every ZATCA payload — tags 1–6 run about 160 bytes, tags 1–9 about
 * 480 — with room to spare. Numeric and alphanumeric modes would encode a digits-only payload
 * more densely and are not implemented, because the ZATCA payload is Base64 and never
 * digits-only. Kanji mode is not implemented for the obvious reason.
 *
 * The output is a boolean matrix. Turning it into pixels is the caller's business, which keeps
 * this module free of any rendering assumption.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Galois field GF(256), the arithmetic Reed–Solomon runs in
// ─────────────────────────────────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  // The generator is 2 and the primitive polynomial is 0x11d, both fixed by the spec.
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j]! ^ gfMul(poly[j]!, EXP[i]!)) as number;
      next[j + 1] = (next[j + 1]! ^ poly[j]!) as number;
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder is the error-correction block. */
function reedSolomon(data: Uint8Array, ecLength: number): Uint8Array {
  const generator = generatorPoly(ecLength);
  const remainder = new Uint8Array(data.length + ecLength);
  remainder.set(data);

  for (let i = 0; i < data.length; i += 1) {
    const factor = remainder[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j += 1) {
      remainder[i + j] = (remainder[i + j]! ^ gfMul(generator[j]!, factor)) as number;
    }
  }

  return remainder.slice(data.length);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Version tables (level M only)
// ─────────────────────────────────────────────────────────────────────────────

/** Total codewords per version, index 1–40. Index 0 is unused. */
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901,
  991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611,
  2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

/** For level M: [EC codewords per block, group-1 blocks, group-2 blocks]. */
const EC_M: [number, number, number][] = [
  [0, 0, 0],
  [10, 1, 0], [16, 1, 0], [26, 1, 0], [18, 2, 0], [24, 2, 0], [16, 4, 0], [18, 4, 0],
  [22, 2, 2], [22, 3, 2], [26, 4, 1], [30, 1, 4], [22, 6, 2], [22, 8, 1], [24, 4, 5],
  [24, 5, 5], [28, 7, 3], [28, 10, 1], [26, 9, 4], [26, 3, 11], [26, 3, 13], [26, 17, 0],
  [28, 17, 0], [28, 4, 14], [28, 6, 14], [28, 8, 13], [28, 19, 4], [28, 22, 3], [28, 3, 23],
  [28, 21, 7], [28, 19, 10], [28, 2, 29], [28, 10, 23], [28, 14, 21], [28, 14, 23],
  [28, 12, 26], [28, 6, 34], [28, 29, 14], [28, 13, 32], [28, 40, 7], [28, 18, 31],
];

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

function dataCodewords(version: number): number {
  const [ecPerBlock, g1, g2] = EC_M[version]!;
  return TOTAL_CODEWORDS[version]! - ecPerBlock * (g1 + g2);
}

/** The smallest version that fits `byteLength` bytes in byte mode at level M. */
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 40; version += 1) {
    // 4 bits mode indicator + 8 or 16 bits length + the data itself.
    const lengthBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= dataCodewords(version)) return version;
  }
  throw new Error(`Payload of ${byteLength} bytes exceeds QR version 40 at level M.`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bit stream
// ─────────────────────────────────────────────────────────────────────────────

class BitBuffer {
  private readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit === 1) bytes[index >>> 3] = (bytes[index >>> 3]! | (0x80 >>> (index & 7))) as number;
    });
    return bytes;
  }
}

/** Mode indicator, length, payload, terminator, padding — then interleaved with the ECC. */
function encodeCodewords(data: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewords(version);
  const buffer = new BitBuffer();

  buffer.put(0b0100, 4); // byte mode
  buffer.put(data.length, version < 10 ? 8 : 16);
  for (const byte of data) buffer.put(byte, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  buffer.put(0, Math.min(4, capacity * 8 - buffer.length));
  while (buffer.length % 8 !== 0) buffer.put(0, 1);

  const bytes = Array.from(buffer.toBytes());
  // The two alternating pad bytes are fixed by the spec, not arbitrary filler.
  const PAD = [0xec, 0x11];
  while (bytes.length < capacity) bytes.push(PAD[(bytes.length - buffer.toBytes().length) % 2]!);

  const [ecPerBlock, g1, g2] = EC_M[version]!;
  const blockCount = g1 + g2;
  const g1Size = Math.floor(capacity / blockCount);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const size = i < g1 ? g1Size : g1Size + 1;
    const block = bytes.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(Array.from(reedSolomon(Uint8Array.from(block), ecPerBlock)));
  }

  // Interleaved: one codeword from each block in turn. This is what spreads a physical
  // smudge across several blocks instead of destroying one of them entirely.
  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i]!);
  }

  return Uint8Array.from(result);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Matrix
// ─────────────────────────────────────────────────────────────────────────────

/** BCH(15,5) for the format string, plus the fixed XOR mask the spec requires. */
function formatBits(mask: number): number {
  // 0b00 is level M in the format encoding.
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (value & (1 << (i + 10))) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** BCH(18,6) for the version string, present from version 7 up. */
function versionBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if (value & (1 << (i + 12))) value ^= 0b1111100100101 << i;
  }
  return (version << 12) | value;
}

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

/**
 * The four penalty rules from the specification.
 *
 * They exist to stop a mask producing something that looks like a finder pattern, or large
 * blank areas a scanner cannot lock onto. The lowest total wins.
 */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;

  // Rule 1: runs of five or more identical modules.
  for (let i = 0; i < size; i += 1) {
    for (const line of [grid[i]!, grid.map((row) => row[i]!)]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (line[j] === line[j - 1]) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like sequence.
  const PATTERN = [true, false, true, true, true, false, true, false, false, false, false];
  const REVERSED = [...PATTERN].reverse();
  for (let i = 0; i < size; i += 1) {
    for (const line of [grid[i]!, grid.map((row) => row[i]!)]) {
      for (let j = 0; j + 11 <= size; j += 1) {
        const window = line.slice(j, j + 11);
        if (window.every((v, k) => v === PATTERN[k])) score += 40;
        if (window.every((v, k) => v === REVERSED[k])) score += 40;
      }
    }
  }

  // Rule 4: deviation from a 50/50 balance of dark and light.
  const dark = grid.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
  readonly version: number;
}

/**
 * Encodes a string into a QR matrix.
 *
 * The input is encoded as UTF-8 bytes. For a ZATCA payload — which is Base64, so ASCII — that
 * is the identity, but taking bytes rather than characters is what makes the module correct for
 * anything else it is handed.
 */
export function encodeQr(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const size = version * 4 + 17;
  const codewords = encodeCodewords(data, version);

  // Two parallel grids. `modules` holds the colour; `fixed` records whether a module belongs to
  // a function pattern. Masking applies to data modules only, and conflating the two is the
  // classic way to produce a code that looks right and scans as nothing.
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const fixed: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  const setFixed = (r: number, c: number, value: boolean): void => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r]![c] = value;
    fixed[r]![c] = true;
  };

  // Finders, with their one-module separators.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const onRing =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFixed(row + r, col + c, onRing || inCore);
      }
    }
  }

  // Alignment patterns, skipping the three that would land on a finder.
  const centres = ALIGNMENT[version] ?? [];
  for (const row of centres) {
    for (const col of centres) {
      if (fixed[row]?.[col] === true) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          setFixed(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  // Timing patterns: the alternating row and column a scanner measures module size against.
  for (let i = 8; i < size - 8; i += 1) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  // The dark module. Always set, always at this coordinate.
  setFixed(size - 8, 8, true);

  // Reserve the format areas, and the version areas from version 7 up. Their contents are
  // written after the mask is chosen, but they must be excluded from data placement now.
  for (let i = 0; i <= 8; i += 1) {
    if (!fixed[8]![i]) setFixed(8, i, false);
    if (!fixed[i]![8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!fixed[8]![size - 1 - i]) setFixed(8, size - 1 - i, false);
    if (!fixed[size - 1 - i]![8]) setFixed(size - 1 - i, 8, false);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        setFixed(size - 11 + j, i, false);
        setFixed(i, size - 11 + j, false);
      }
    }
  }

  // Data placement: two-module columns, right to left, alternating upward and downward,
  // skipping the vertical timing column at index 6.
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (fixed[row]![col]) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        modules[row]![col] = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  // Choose the mask by penalty. The specification requires this rather than suggesting it: a
  // fixed mask can produce an unscannable code for particular data.
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let best: boolean[][] = modules;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row, r) =>
      row.map((value, c) => (fixed[r]![c] ? value : value !== maskAt(mask, r, c))),
    );
    writeFormat(candidate, size, mask);
    if (version >= 7) writeVersion(candidate, size, version);

    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = candidate;
    }
  }

  void bestMask;
  return { size, modules: best, version };
}

/** Format information — level M plus the mask — written into both of its two copies. */
function writeFormat(grid: boolean[][], size: number, mask: number): void {
  const bits = formatBits(mask);

  for (let i = 0; i <= 5; i += 1) grid[8]![i] = ((bits >>> i) & 1) === 1;
  grid[8]![7] = ((bits >>> 6) & 1) === 1;
  grid[8]![8] = ((bits >>> 7) & 1) === 1;
  grid[7]![8] = ((bits >>> 8) & 1) === 1;
  for (let i = 9; i <= 14; i += 1) grid[14 - i]![8] = ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 7; i += 1) grid[size - 1 - i]![8] = ((bits >>> i) & 1) === 1;
  for (let i = 8; i <= 14; i += 1) grid[8]![size - 15 + i] = ((bits >>> i) & 1) === 1;

  grid[size - 8]![8] = true;
}

/** Version information, present from version 7 up, written into both of its copies. */
function writeVersion(grid: boolean[][], size: number, version: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    grid[Math.floor(i / 3)]![size - 11 + (i % 3)] = bit;
    grid[size - 11 + (i % 3)]![Math.floor(i / 3)] = bit;
  }
}

/**
 * Renders a matrix as a self-contained SVG path.
 *
 * One `<path>` of rectangles rather than one element per module: a version-10 code is 57x57,
 * so that is 3,249 elements against one, and the browser's print pipeline notices the
 * difference. The quiet zone is four modules, which the specification requires and scanners
 * genuinely need.
 */
export function qrToSvgPath(matrix: QrMatrix): { path: string; extent: number } {
  const QUIET = 4;
  const extent = matrix.size + QUIET * 2;
  const parts: string[] = [];

  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.modules[r]![c]) parts.push(`M${c + QUIET} ${r + QUIET}h1v1h-1z`);
    }
  }

  return { path: parts.join(''), extent };
}
