#!/usr/bin/env node
'use strict';

const MAGIC = [0x4d, 0x4f, 0x55, 0x54];
const VERSION = 1;
const MAX_BLOCK = (1 << 24) - 1;
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
    while (n < bits) { acc = (acc << 8) | this.buf[this.pos++]; n += 8; }
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

function encodeSequence(bw, seq, n) {
  const count = new Int32Array(256);
  for (let i = 0; i < n; i++) count[seq[i]]++;
  const syms = [];
  for (let c = 0; c < 256; c++) if (count[c] > 0) syms.push(c);
  syms.sort((a, b) => count[b] - count[a] || a - b);
  bw.write(syms.length - 1, 8);
  for (const c of syms) { bw.write(c, 8); writeNum(bw, count[c]); }

  const P = new Int32Array((n >> 1) + 1);
  const bufA = new Uint8Array(n), bufB = new Uint8Array(n);
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
  let total = 0;
  for (let s = 0; s < k; s++) {
    syms[s] = br.read(8);
    count[s] = readNum(br);
    if (count[s] < 1 || count[s] > n) throw new Error('corrupt data');
    total += count[s];
  }
  if (total !== n) throw new Error('corrupt data');

  const P = new Int32Array(n);
  const start = new Int32Array(k), len = new Int32Array(k);
  let m = n, off = 0;
  for (let s = 0; s < k - 1; s++) {
    const f = count[s];
    start[s] = off;
    len[s] = 2 * f <= m ? f : m - f;
    decodeMiddleOut(br, P, off, off + len[s] - 1, 0, m - 1);
    off += len[s];
    m -= f;
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
  const s = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) s[i] = T[i] + 1;
  const SA = new Int32Array(n + 1);
  suffixArray(s, SA, n + 1, 257);
  const K = chainsFor(n), seg = Math.floor(n / K), rem = n - K * seg;
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
    for (let k = rem - 1; k >= 0; k--) { const v = next[r0]; T[k] = v & 255; r0 = v >>> 8; }
  } else {
    for (let k = n - 1, row = 0; k >= 0; k--) { const v = next[row]; T[k] = v & 255; row = v >>> 8; }
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
  const order = new Uint8Array(256), out = new Uint8Array(n);
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
  const { L, primary, rows } = bwtForward(block);
  let best = null, bestMode = MODE_STORED;
  for (const mode of [MODE_DIRECT, MODE_MTF]) {
    const bw = new BitWriter((n >> 1) + 1024);
    writeNum(bw, primary);
    for (let i = 0; i < rows.length; i++) writeNum(bw, rows[i]);
    encodeSequence(bw, mode === MODE_MTF ? mtfEncode(L, n) : L, n);
    const out = bw.finish();
    if (best === null || out.length < best.length) { best = out; bestMode = mode; }
  }
  return best.length + 4 < n ? { mode: bestMode, payload: best } : { mode: MODE_STORED, payload: block };
}

function decodeBlock(mode, payload, n) {
  const br = new BitReader(payload);
  const primary = readNum(br);
  if (primary < 1 || primary > n) throw new Error('corrupt data');
  const rows = new Int32Array(chainsFor(n) - 1);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = readNum(br);
    if (rows[i] > n) throw new Error('corrupt data');
  }
  const seq = decodeSequence(br, n);
  return bwtInverse(mode === MODE_MTF ? mtfDecode(seq, n) : seq, n, primary, rows);
}

function compress(input, options = {}) {
  const blockSize = Math.max(1, Math.min(MAX_BLOCK, Math.floor(options.blockSize || MAX_BLOCK)));
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

function decompress(data) {
  let p = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do {
      if (p >= data.length) throw new Error('truncated data');
      b = data[p++];
      v += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    return v;
  };
  for (const m of MAGIC) if (data[p++] !== m) throw new Error('not a middle-out file');
  if (data[p++] !== VERSION) throw new Error('unsupported version');
  const total = varint();
  const out = new Uint8Array(total);
  let pos = 0;
  while (pos < total) {
    const mode = data[p++];
    const n = varint();
    if (n < 1 || n > MAX_BLOCK || n > total - pos || !(mode <= MODE_MTF)) throw new Error('corrupt data');
    if (mode === MODE_STORED) {
      if (p + n > data.length) throw new Error('truncated data');
      out.set(data.subarray(p, p + n), pos);
      p += n;
    } else {
      const len = varint();
      if (p + len > data.length) throw new Error('truncated data');
      out.set(decodeBlock(mode, data.subarray(p, p + len), n), pos);
      p += len;
    }
    pos += n;
  }
  if (p + 4 > data.length) throw new Error('truncated data');
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
  const fmt = (x) => Math.round(x).toLocaleString('en-US');
  for (const file of files) {
    const data = fs.readFileSync(file);
    const n = data.length;
    if (n === 0) { console.log(`\n${file}: empty, skipped`); continue; }
    const rows = [];
    const run = (name, fn) => {
      let best = Infinity, size = null;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        try { size = fn(); } catch (e) { size = null; }
        const ms = performance.now() - t0;
        if (size === null) return;
        best = Math.min(best, ms);
        if (ms > 1500) break;
      }
      rows.push({ name, size, ms: best });
    };
    const cli = (cmd, args) => () => {
      const r = spawnSync(cmd, args, { input: data, maxBuffer: Infinity });
      return r.error || r.status !== 0 ? null : r.stdout.length;
    };
    run('gzip -6', () => zlib.gzipSync(data, { level: 6 }).length);
    run('bzip2 -9', cli('bzip2', ['-9', '-c']));
    run('xz -6', cli('xz', ['-6', '-T1', '-c']));
    if (zlib.zstdCompressSync) {
      run('zstd -19', () => zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }).length);
    }
    run('brotli -11', () => zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: n,
      },
    }).length);
    compress(data.subarray(0, Math.min(n, 1 << 18)));
    let packed;
    run('middle-out', () => (packed = compress(data, { blockSize })).length);
    const t0 = performance.now();
    const back = decompress(packed);
    const unpackMs = performance.now() - t0;

    const ref = rows[0];
    console.log(`\n${file}: ${fmt(n)} bytes`);
    console.log('  compressor       bytes     ratio   time (ms)   Weissman');
    for (const r of rows) {
      const ratio = n / r.size;
      const w = ref.ms > 1 && r.ms > 1 ? ((ratio / (n / ref.size)) * Math.log(ref.ms)) / Math.log(r.ms) : NaN;
      console.log(`  ${r.name.padEnd(11)}${fmt(r.size).padStart(11)}${ratio.toFixed(2).padStart(10)}${fmt(r.ms).padStart(12)}${(Number.isNaN(w) ? 'n/a' : w.toFixed(2)).padStart(11)}`);
    }
    console.log(`  middle-out round-trip: ${sameBytes(back, data) ? 'byte-exact' : 'MISMATCH'} (decompressed in ${fmt(unpackMs)} ms)`);
  }
}

function main() {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const [cmd, ...rest] = args.filter((a) => !a.startsWith('--'));
  const blockFlag = flags.find((f) => f.startsWith('--block='));
  const blockSize = blockFlag ? Math.round(parseFloat(blockFlag.slice(8)) * 1048576) : MAX_BLOCK;
  const force = flags.includes('--force');
  const usage = () => {
    console.log('usage: node middleout.js c|d <file> [out]   |   bench <file>...   |   test');
    console.log('       options: --block=<MiB> (default 16), --force (overwrite output)');
    process.exitCode = 1;
  };
  if (cmd === 'test') return selfTest();
  if (cmd === 'bench' && rest.length) return bench(rest, blockSize);
  if ((cmd !== 'c' && cmd !== 'd') || !rest[0]) return usage();
  const input = rest[0];
  const output = rest[1] || (cmd === 'c' ? input + '.mo' : input.endsWith('.mo') ? input.slice(0, -3) : input + '.out');
  if (fs.existsSync(output) && !force) {
    console.error(`${output} already exists (use --force to overwrite)`);
    process.exitCode = 1;
    return;
  }
  const data = fs.readFileSync(input);
  const t0 = performance.now();
  let result;
  try {
    result = cmd === 'c' ? compress(data, { blockSize }) : decompress(data);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const ms = performance.now() - t0;
  fs.writeFileSync(output, result);
  const [big, small] = cmd === 'c' ? [data.length, result.length] : [result.length, data.length];
  console.log(`${input} -> ${output}: ${data.length.toLocaleString('en-US')} -> ${result.length.toLocaleString('en-US')} bytes` +
    ` (ratio ${small ? (big / small).toFixed(2) : '-'}, ${Math.round(ms)} ms)`);
}

if (require.main === module) main();