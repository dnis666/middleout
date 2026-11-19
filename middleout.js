#!/usr/bin/env node
'use strict';

const { performance } = require('perf_hooks');

const MAGIC = [0x4d, 0x4f, 0x55, 0x54];
const VERSION = 1;
const MAX_BLOCK = (1 << 24) - 1;
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;
const MODE_STORED = 0, MODE_DIRECT = 1, MODE_MTF = 2;

class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(64, capacity));
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }
  write(value, bits) {
    if (this.pos + 4 > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    const acc = (this.acc << bits) | value;
    let n = this.n + bits;
    while (n >= 8) { n -= 8; this.buf[this.pos++] = acc >>> n; }
    this.acc = acc & ((1 << n) - 1);
    this.n = n;
  }
  finish() {
    if (this.n > 0) { this.buf[this.pos++] = this.acc << (8 - this.n); this.n = 0; this.acc = 0; }
    return this.buf.subarray(0, this.pos);
  }
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.acc = 0; this.n = 0; }
  read(bits) {
    let acc = this.acc, n = this.n;
    while (n < bits) {
      if (this.pos >= this.buf.length) throw new Error('truncated bitstream');
      acc = (acc << 8) | this.buf[this.pos++]; n += 8;
    }
    n -= bits;
    this.acc = acc & ((1 << n) - 1);
    this.n = n;
    return acc >>> n;
  }
}

function writeNum(bw, v) {
  const len = 32 - Math.clz32(v);
  bw.write(len, 5);
  if (len > 1) bw.write(v - (1 << (len - 1)), len - 1);
}
function readNum(br) {
  const len = br.read(5);
  if (len > 24) throw new Error('invalid integer width');
  if (len < 2) return len;
  return (1 << (len - 1)) + br.read(len - 1);
}

function writeBounded(bw, x, r) {
  if (r === 1) return;
  const k = 31 - Math.clz32(r);
  const u = (1 << (k + 1)) - r;
  if (x < u) bw.write(x, k); else bw.write(x + u, k + 1);
}
function readBounded(br, r) {
  if (r === 1) return 0;
  const k = 31 - Math.clz32(r);
  const u = (1 << (k + 1)) - r;
  const x = br.read(k);
  return x < u ? x : ((x << 1) | br.read(1)) - u;
}

function encodeMiddleOut(bw, P, i, j, lo, hi) {
  while (i <= j) {
    if (hi - lo === j - i) return;
    const mid = (i + j) >>> 1, v = P[mid];
    const min = lo + (mid - i), max = hi - (j - mid);
    writeBounded(bw, v - min, max - min + 1);
    encodeMiddleOut(bw, P, i, mid - 1, lo, v - 1);
    i = mid + 1; lo = v + 1;
  }
}
function decodeMiddleOut(br, P, i, j, lo, hi) {
  while (i <= j) {
    if (hi - lo === j - i) { while (i <= j) P[i++] = lo++; return; }
    const mid = (i + j) >>> 1;
    const min = lo + (mid - i), max = hi - (j - mid);
    const v = min + readBounded(br, max - min + 1);
    P[mid] = v;
    decodeMiddleOut(br, P, i, mid - 1, lo, v - 1);
    i = mid + 1; lo = v + 1;
  }
}

function encodeSequence(bw, seq, n, mutable) {
  const count = new Int32Array(256);
  for (let i = 0; i < n; i++) count[seq[i]]++;
  const syms = [];
  for (let c = 0; c < 256; c++) if (count[c] > 0) syms.push(c);
  syms.sort((a, b) => count[b] - count[a] || a - b);
  bw.write(syms.length - 1, 8);
  for (const c of syms) { bw.write(c, 8); writeNum(bw, count[c]); }

  if (syms.length === 1) return;
  const P = new Int32Array((n >> 1) + 1);
  const bufA = new Uint8Array(n), bufB = mutable ? seq : new Uint8Array(n);
  let src = seq, m = n;
  for (let s = 0; s < syms.length - 1; s++) {
    const c = syms[s], f = count[c];
    const dst = src === bufA ? bufB : bufA;
    let p = 0, w = 0;
    if (2 * f <= m) {
      for (let i = 0; i < m; i++) { const x = src[i]; if (x === c) P[p++] = i; else dst[w++] = x; }
    } else {
      for (let i = 0; i < m; i++) { const x = src[i]; if (x !== c) { P[p++] = i; dst[w++] = x; } }
    }
    encodeMiddleOut(bw, P, 0, p - 1, 0, m - 1);
    src = dst; m = w;
  }
}

function decodeSequence(br, n) {
  const k = br.read(8) + 1;
  const syms = new Uint8Array(k), count = new Int32Array(k);
  const seen = new Uint8Array(256);
  let total = 0;
  for (let s = 0; s < k; s++) {
    syms[s] = br.read(8);
    if (seen[syms[s]]) throw new Error('duplicate symbol');
    seen[syms[s]] = 1;
    count[s] = readNum(br);
    if (count[s] < 1 || count[s] > n) throw new Error('corrupt data');
    total += count[s];
  }
  if (total !== n) throw new Error('corrupt data');
  if (k === 1) return new Uint8Array(n).fill(syms[0]);

  const start = new Int32Array(k), len = new Int32Array(k);
  let m = n, off = 0;
  for (let s = 0; s < k - 1; s++) {
    const f = count[s];
    start[s] = off;
    len[s] = 2 * f <= m ? f : m - f;
    off += len[s];
    m -= f;
  }
  const P = new Int32Array(off);
  for (let s = 0, remaining = n; s < k - 1; remaining -= count[s++]) {
    decodeMiddleOut(br, P, start[s], start[s] + len[s] - 1, 0, remaining - 1);
  }
  let cur = new Uint8Array(n), nxt = new Uint8Array(n);
  cur.fill(syms[k - 1], 0, m);
  for (let s = k - 2; s >= 0; s--) {
    const c = syms[s], f = count[s], size = m + f;
    let p = start[s], r = 0;
    const end = p + len[s];
    let next = p < end ? P[p] : -1;
    if (2 * f <= size) {
      for (let i = 0; i < size; i++) {
        if (i === next) { nxt[i] = c; next = ++p < end ? P[p] : -1; } else nxt[i] = cur[r++];
      }
    } else {
      for (let i = 0; i < size; i++) {
        if (i === next) { nxt[i] = cur[r++]; next = ++p < end ? P[p] : -1; } else nxt[i] = c;
      }
    }
    const tmp = cur; cur = nxt; nxt = tmp;
    m = size;
  }
  return cur;
}

function suffixArray(s, SA, n, K) {
  s[n - 1] = (s[n - 1] << 1) | 1;
  for (let i = n - 2; i >= 0; i--) {
    const c = s[i] << 1;
    s[i] = c < s[i + 1] ? c | 1 : c;
  }
  const isLMS = (i) => i > 0 && (s[i] & 1) === 1 && (s[i - 1] & 1) === 0;
  const count = new Int32Array(K), bkt = new Int32Array(K);
  for (let i = 0; i < n; i++) count[s[i] >> 1]++;
  const bucketStarts = () => { for (let c = 0, sum = 0; c < K; c++) { bkt[c] = sum; sum += count[c]; } };
  const bucketEnds = () => { for (let c = 0, sum = 0; c < K; c++) { sum += count[c]; bkt[c] = sum; } };
  const induce = (mark) => {
    bucketStarts();
    for (let i = 0; i < n; i++) {
      const j = SA[i] - 1;
      if (j >= 0) { const c = s[j]; if ((c & 1) === 0) SA[bkt[c >> 1]++] = j; }
    }
    bucketEnds();
    for (let i = n - 1; i >= 0; i--) {
      const j = SA[i] - 1;
      if (j >= 0) {
        const c = s[j];
        if ((c & 1) === 1) SA[--bkt[c >> 1]] = mark && j > 0 && (s[j - 1] & 1) === 0 ? ~j : j;
      }
    }
  };

  bucketEnds();
  SA.fill(-1, 0, n);
  for (let i = 1; i < n; i++) if (isLMS(i)) SA[--bkt[s[i] >> 1]] = i;
  induce(true);
  let n1 = 1;
  for (let i = 1; i < n; i++) { const v = SA[i]; if (v < 0) SA[n1++] = ~v; }

  SA.fill(-1, n1, n);
  let names = 0, prev = -1;
  for (let i = 0; i < n1; i++) {
    const pos = SA[i];
    let diff = prev === -1;
    for (let d = 0; !diff && d < n; d++) {
      if (s[pos + d] !== s[prev + d]) diff = true;
      else if (d > 0 && isLMS(pos + d)) break;
    }
    if (diff) { names++; prev = pos; }
    SA[n1 + (pos >> 1)] = names - 1;
  }
  for (let i = n - 1, j = n - 1; i >= n1; i--) if (SA[i] >= 0) SA[j--] = SA[i];
  const SA1 = SA.subarray(0, n1), s1 = SA.subarray(n - n1, n);
  if (names < n1) suffixArray(s1, SA1, n1, names);
  else for (let i = 0; i < n1; i++) SA1[s1[i]] = i;

  bucketEnds();
  for (let i = 1, j = 0; i < n; i++) if (isLMS(i)) s1[j++] = i;
  for (let i = 0; i < n1; i++) SA1[i] = s1[SA1[i]];
  SA.fill(-1, n1, n);
  for (let i = n1 - 1; i >= 0; i--) { const j = SA[i]; SA[i] = -1; SA[--bkt[s[j] >> 1]] = j; }
  induce(false);
}

const chainsFor = (n) => (n >= 4096 ? 8 : 1);

function bwtForward(T) {
  const n = T.length;
  const K = chainsFor(n), seg = Math.floor(n / K), rem = n - K * seg;
  let uniform = true;
  for (let i = 1; i < n; i++) if (T[i] !== T[0]) { uniform = false; break; }
  if (uniform) {
    const rows = new Int32Array(K - 1);
    for (let i = 0; i < rows.length; i++) rows[i] = n - rem - (i + 1) * seg;
    return { L: T, primary: n, rows, uniform };
  }
  const s = new Uint16Array(n + 1);
  for (let i = 0; i < n; i++) s[i] = T[i] + 1;
  const SA = new Int32Array(n + 1);
  suffixArray(s, SA, n + 1, 257);
  const L = new Uint8Array(n), rows = new Int32Array(K - 1);
  let primary = 0;
  for (let i = 0, j = 0; i <= n; i++) {
    const p = SA[i];
    if (p === 0) primary = i; else L[j++] = T[p - 1];
    if (p % seg === rem && p > rem && p < n) rows[(p - rem) / seg - 1] = i;
  }
  return { L, primary, rows };
}

function bwtInverse(L, n, primary, rows) {
  const C = new Int32Array(257);
  for (let i = 0; i < n; i++) C[L[i] + 1]++;
  if (C[L[0] + 1] === n) {
    if (primary !== n) throw new Error('invalid BWT primary index');
    const seg = Math.floor(n / chainsFor(n)), rem = n % chainsFor(n);
    for (let i = 0; i < rows.length; i++) if (rows[i] !== n - rem - (i + 1) * seg) throw new Error('invalid BWT chains');
    return L;
  }
  for (let c = 0, sum = 1; c < 256; c++) { const f = C[c + 1]; C[c] = sum; sum += f; }
  const next = new Uint32Array(n + 1);
  for (let j = 0; j < n; j++) {
    const c = L[j];
    next[j < primary ? j : j + 1] = (C[c]++ << 8) | c;
  }
  const T = new Uint8Array(n);
  if (rows.length === 7) {
    const seg = Math.floor(n / 8), rem = n - 8 * seg;
    const s2 = 2 * seg, s3 = 3 * seg, s4 = 4 * seg, s5 = 5 * seg, s6 = 6 * seg, s7 = 7 * seg;
    let r0 = rows[0], r1 = rows[1], r2 = rows[2], r3 = rows[3], r4 = rows[4], r5 = rows[5], r6 = rows[6], r7 = 0;
    for (let e = rem + seg - 1; e >= rem; e--) {
      let v = next[r0]; T[e] = v & 255; r0 = v >>> 8;
      v = next[r1]; T[e + seg] = v & 255; r1 = v >>> 8;
      v = next[r2]; T[e + s2] = v & 255; r2 = v >>> 8;
      v = next[r3]; T[e + s3] = v & 255; r3 = v >>> 8;
      v = next[r4]; T[e + s4] = v & 255; r4 = v >>> 8;
      v = next[r5]; T[e + s5] = v & 255; r5 = v >>> 8;
      v = next[r6]; T[e + s6] = v & 255; r6 = v >>> 8;
      v = next[r7]; T[e + s7] = v & 255; r7 = v >>> 8;
    }
    if (r1 !== rows[0] || r2 !== rows[1] || r3 !== rows[2] || r4 !== rows[3] || r5 !== rows[4] || r6 !== rows[5] || r7 !== rows[6]) throw new Error('invalid BWT chains');
    for (let k = rem - 1; k >= 0; k--) { const v = next[r0]; T[k] = v & 255; r0 = v >>> 8; }
    if (r0 !== primary) throw new Error('invalid BWT primary index');
  } else {
    let row = 0;
    for (let k = n - 1; k >= 0; k--) { const v = next[row]; T[k] = v & 255; row = v >>> 8; }
    if (row !== primary) throw new Error('invalid BWT primary index');
  }
  return T;
}

function mtfEncode(src, n) {
  const order = new Uint8Array(256), out = new Uint8Array(n);
  for (let i = 0; i < 256; i++) order[i] = i;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    let r = 0;
    while (order[r] !== c) r++;
    out[i] = r;
    for (; r > 0; r--) order[r] = order[r - 1];
    order[0] = c;
  }
  return out;
}
function mtfDecode(src, n) {
  const order = new Uint8Array(256), out = src;
  for (let i = 0; i < 256; i++) order[i] = i;
  for (let i = 0; i < n; i++) {
    let r = src[i];
    const c = order[r];
    out[i] = c;
    for (; r > 0; r--) order[r] = order[r - 1];
    order[0] = c;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pushVarint(arr, v) {
  while (v >= 128) { arr.push((v % 128) | 128); v = Math.floor(v / 128); }
  arr.push(v);
}

function encodeBlock(block) {
  const n = block.length;
  if (n <= 4) return { mode: MODE_STORED, payload: block };
  const { L, primary, rows, uniform } = bwtForward(block);
  let best = null, bestMode = MODE_STORED;
  for (const mode of uniform ? [MODE_DIRECT] : [MODE_DIRECT, MODE_MTF]) {
    const bw = new BitWriter(uniform ? 64 : (n >> 1) + 1024);
    writeNum(bw, primary);
    for (let i = 0; i < rows.length; i++) writeNum(bw, rows[i]);
    encodeSequence(bw, mode === MODE_MTF ? mtfEncode(L, n) : L, n, mode === MODE_MTF);
    const out = bw.finish();
    if (best === null || out.length < best.length) { best = out; bestMode = mode; }
  }
  const lengthBytes = best.length < 128 ? 1 : best.length < 16384 ? 2 : best.length < 2097152 ? 3 : 4;
  return best.length + lengthBytes < n ? { mode: bestMode, payload: best.slice() } : { mode: MODE_STORED, payload: block };
}

function decodeBlock(mode, payload, n) {
  const br = new BitReader(payload);
  const primary = readNum(br);
  if (primary < 1 || primary > n) throw new Error('corrupt data');
  const rows = new Int32Array(chainsFor(n) - 1);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = readNum(br);
    if (rows[i] < 1 || rows[i] > n || rows[i] === primary) throw new Error('corrupt data');
  }
  const seq = decodeSequence(br, n);
  if (br.pos !== payload.length || br.acc !== 0) throw new Error('trailing payload data');
  return bwtInverse(mode === MODE_MTF ? mtfDecode(seq, n) : seq, n, primary, rows);
}

function compress(input, options = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
  const requested = options.blockSize === undefined ? MAX_BLOCK : options.blockSize;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) throw new RangeError('blockSize must be a positive finite number');
  const blockSize = Math.max(1, Math.min(MAX_BLOCK, Math.floor(requested)));
  const head = [...MAGIC, VERSION];
  pushVarint(head, input.length);
  const chunks = [Uint8Array.from(head)];
  for (let off = 0; off < input.length; off += blockSize) {
    const block = input.subarray(off, Math.min(input.length, off + blockSize));
    const { mode, payload } = encodeBlock(block);
    const h = [mode];
    pushVarint(h, block.length);
    if (mode !== MODE_STORED) pushVarint(h, payload.length);
    chunks.push(Uint8Array.from(h), payload);
  }
  const crc = crc32(input);
  chunks.push(Uint8Array.of(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24));
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

function decompress(data, options = {}) {
  if (!(data instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
  const maxOutputLength = options.maxOutputLength === undefined ? DEFAULT_MAX_OUTPUT : options.maxOutputLength;
  const maxBlockSize = options.maxBlockSize === undefined ? MAX_BLOCK : options.maxBlockSize;
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 0) throw new RangeError('invalid maxOutputLength');
  if (!Number.isInteger(maxBlockSize) || maxBlockSize < 1 || maxBlockSize > MAX_BLOCK) throw new RangeError('invalid maxBlockSize');
  let p = 0;
  const varint = () => {
    let v = 0, mul = 1;
    for (let i = 0; i < 8; i++) {
      if (p >= data.length) throw new Error('truncated data');
      const b = data[p++];
      v += (b & 127) * mul;
      if (!Number.isSafeInteger(v)) throw new Error('varint overflow');
      if (!(b & 128)) {
        if (i > 0 && b === 0) throw new Error('noncanonical varint');
        return v;
      }
      mul *= 128;
    }
    throw new Error('varint overflow');
  };
  for (const m of MAGIC) if (data[p++] !== m) throw new Error('not a middle-out file');
  if (data[p++] !== VERSION) throw new Error('unsupported version');
  const total = varint();
  if (total > maxOutputLength) throw new RangeError('output exceeds maxOutputLength');
  const blocksStart = p;
  const scan = (out) => {
    let pos = 0;
    while (pos < total) {
      const mode = data[p++];
      const n = varint();
      if (n < 1 || n > maxBlockSize || n > total - pos || !(mode <= MODE_MTF)) throw new Error('invalid block metadata');
      const len = mode === MODE_STORED ? n : varint();
      if (len < 1 || len > data.length - p - 4) throw new Error('truncated block');
      if (out) {
        const payload = data.subarray(p, p + len);
        out.set(mode === MODE_STORED ? payload : decodeBlock(mode, payload, n), pos);
      }
      p += len;
      pos += n;
    }
    if (p + 4 !== data.length) throw new Error('truncated checksum or trailing data');
  };
  scan(null);
  const out = new Uint8Array(total);
  p = blocksStart;
  scan(out);
  const crc = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
  if (crc !== crc32(out)) throw new Error('checksum mismatch: data is corrupt');
  return out;
}

module.exports = { compress, decompress };

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function selfTest() {
  let seed = 42;
  const rnd = (k) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % k;
  };
  const cases = [];
  const add = (name, bytes) => cases.push([name, Uint8Array.from(bytes)]);
  add('empty', []);
  add('one byte', [42]);
  add('two equal bytes', [7, 7]);
  add('abracadabra', Buffer.from('abracadabra'));
  add('100000 equal bytes', new Uint8Array(100000).fill(97));
  add('all 256 values, repeated', Array.from({ length: 256 * 40 }, (_, i) => i & 255));
  add('50000 random bytes', Array.from({ length: 50000 }, () => rnd(256)));
  const vocab = 'the middle out of a file is where compression begins and every byte finds its place'.split(' ');
  let text = '';
  while (text.length < 200000) text += vocab[rnd(vocab.length)] + (rnd(10) ? ' ' : '.\n');
  add('200000 bytes of word soup', Buffer.from(text));
  for (let i = 0; i < 500; i++) {
    const n = rnd(400), alphabet = 1 + rnd(6);
    add(`fuzz #${i}`, Array.from({ length: n }, () => rnd(alphabet)));
  }
  for (let i = 0; i < 40; i++) {
    const n = 4090 + rnd(40), period = 1 + rnd(50);
    add(`periodic #${i}`, Array.from({ length: n }, (_, j) => (j % period) * 7 + (rnd(50) ? 0 : 1)));
  }
  let runs = 0, fails = 0;
  for (const [name, data] of cases) {
    for (const blockSize of [MAX_BLOCK, 4096, 97]) {
      runs++;
      try {
        if (!sameBytes(decompress(compress(data, { blockSize })), data)) throw new Error('output differs');
      } catch (e) {
        fails++;
        console.log(`FAIL  ${name} (block ${blockSize}): ${e.message}`);
      }
    }
  }
  const packed = compress(Buffer.from(text));
  let caught = 0;
  const flips = 200;
  for (let i = 0; i < flips; i++) {
    const bad = packed.slice();
    bad[rnd(bad.length)] ^= 1 << rnd(8);
    try { decompress(bad); } catch (e) { caught++; }
  }
  if (caught !== flips) { fails++; console.log(`FAIL  only ${caught}/${flips} corrupted files were rejected`); }
  console.log(fails ? `${fails} FAILED` : `OK: ${runs} round-trips byte-exact, ${flips}/${flips} corrupted files rejected`);
  process.exitCode = fails ? 1 : 0;
}

function bench(files, blockSize) {
  const fs = require('fs');
  const zlib = require('zlib');
  const { spawnSync } = require('child_process');
  const external = (cmd, args) => data => {
    const result = spawnSync(cmd, args, { input: data, maxBuffer: 512 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr.toString().trim()}`);
    return result.stdout;
  };
  const median = values => values.slice().sort((a, b) => a - b)[1];
  for (const file of files) {
    const data = fs.readFileSync(file);
    const codecs = [
      ['gzip -6', input => zlib.gzipSync(input, { level: 6 }), input => zlib.gunzipSync(input)],
      ['bzip2 -9', external('bzip2', ['-9', '-c']), external('bzip2', ['-d', '-c'])],
      ['xz -6', external('xz', ['-6', '-T1', '-c']), external('xz', ['-d', '-T1', '-c'])],
      ['zstd -19', external('zstd', ['-19', '-T1', '-q', '-c']), external('zstd', ['-d', '-q', '-c'])],
      ['brotli -11', input => zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), input => zlib.brotliDecompressSync(input)],
      ['middle-out', input => compress(input, { blockSize }), input => decompress(input, { maxOutputLength: data.length })],
    ];
    if (zlib.zstdCompressSync) codecs[3] = ['zstd -19', input => zlib.zstdCompressSync(input, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }), input => zlib.zstdDecompressSync(input)];
    console.log(`\n${file}: ${data.length} bytes; one warm-up, three measured round-trips`);
    console.log('compressor       bytes    ratio   encode ms   decode ms   encode range ms');
    for (const [name, pack, unpack] of codecs) {
      let warm;
      try { warm = pack(data); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        console.log(`${name}: unavailable`); continue;
      }
      if (!sameBytes(unpack(warm), data)) throw new Error(`${name}: round-trip mismatch`);
      const encode = [], decode = [];
      let size = 0;
      for (let i = 0; i < 3; i++) {
        let start = performance.now();
        const packed = pack(data);
        encode.push(performance.now() - start);
        size = packed.length;
        start = performance.now();
        const back = unpack(packed);
        decode.push(performance.now() - start);
        if (!sameBytes(back, data)) throw new Error(`${name}: round-trip mismatch`);
      }
      console.log(`${name.padEnd(13)}${String(size).padStart(9)}${(data.length / size).toFixed(2).padStart(9)}${median(encode).toFixed(2).padStart(12)}${median(decode).toFixed(2).padStart(12)}   ${Math.min(...encode).toFixed(2)}–${Math.max(...encode).toFixed(2)}`);
    }
  }
}

function main() {
  const fs = require('fs');
  const path = require('path');
  const flags = new Map(), positional = [];
  let literal = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--' && !literal) { literal = true; continue; }
    if (!literal && arg.startsWith('--')) {
      const split = arg.indexOf('=');
      const key = split < 0 ? arg : arg.slice(0, split);
      if (!['--block', '--max-output', '--force', '--help'].includes(key) || flags.has(key)) throw new Error(`invalid or duplicate option: ${arg}`);
      const value = split < 0 ? true : arg.slice(split + 1);
      if ((key === '--force' || key === '--help') && value !== true) throw new Error(`invalid option: ${arg}`);
      flags.set(key, value);
    } else positional.push(arg);
  }
  const usage = () => {
    console.log('usage: middleout c|d <file> [out] | bench <file>... | test');
    console.log('options: --block=<MiB>, --max-output=<MiB> (decode, default 256), --force, --help');
  };
  if (flags.has('--help')) return usage();
  const [cmd, ...rest] = positional;
  if (!['c', 'd', 'bench', 'test'].includes(cmd) || (cmd === 'test' ? rest.length !== 0 : rest.length < 1) || ((cmd === 'c' || cmd === 'd') && rest.length > 2)) {
    usage(); process.exitCode = 1; return;
  }
  const mib = (key, fallback) => {
    if (!flags.has(key)) return fallback;
    const raw = flags.get(key);
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) * 1048576 : NaN;
    if (!Number.isSafeInteger(Math.round(value)) || value <= 0) throw new Error(`${key} requires a positive MiB value`);
    return Math.max(1, Math.round(value));
  };
  if (flags.has('--max-output') && cmd !== 'd') throw new Error('--max-output is only valid for decompression');
  if (flags.has('--block') && cmd !== 'c' && cmd !== 'bench') throw new Error('--block is only valid for compression and benchmarks');
  if (flags.has('--force') && cmd !== 'c' && cmd !== 'd') throw new Error('--force is only valid for file output');
  const blockSize = mib('--block', MAX_BLOCK);
  const maxOutputLength = mib('--max-output', DEFAULT_MAX_OUTPUT);
  if (cmd === 'test') return selfTest();
  if (cmd === 'bench') return bench(rest, blockSize);
  const input = rest[0];
  const output = rest[1] || (cmd === 'c' ? input + '.mo' : input.endsWith('.mo') ? input.slice(0, -3) : input + '.out');
  const force = flags.has('--force');
  if (path.resolve(input) === path.resolve(output)) throw new Error('input and output must be different files');
  if (fs.existsSync(output)) {
    const src = fs.statSync(input), dst = fs.statSync(output);
    if (src.dev === dst.dev && src.ino === dst.ino) throw new Error('input and output must be different files');
    if (!force) throw new Error(`${output} already exists (use --force to overwrite)`);
  }
  const data = fs.readFileSync(input);
  const t0 = performance.now();
  const result = cmd === 'c' ? compress(data, { blockSize }) : decompress(data, { maxOutputLength });
  const ms = performance.now() - t0;
  const tempDir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), '.middleout-'));
  const temp = path.join(tempDir, 'output');
  try {
    fs.writeFileSync(temp, result);
    if (force) fs.renameSync(temp, output);
    else fs.linkSync(temp, output);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  const [big, small] = cmd === 'c' ? [data.length, result.length] : [result.length, data.length];
  console.log(`${input} -> ${output}: ${data.length.toLocaleString('en-US')} -> ${result.length.toLocaleString('en-US')} bytes` +
    ` (ratio ${small ? (big / small).toFixed(2) : '-'}, ${Math.round(ms)} ms)`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
