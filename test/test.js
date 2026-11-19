'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { compress, decompress } = require('../middleout');
const root = path.resolve(__dirname, '..');
let checks = 0;
const test = (name, fn) => { fn(); checks++; };
const equal = (a, b) => assert.deepStrictEqual(Buffer.from(a), Buffer.from(b));
let seed = 937;
const random = n => {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; out[i] = seed & 255; }
  return out;
};
const varint = value => {
  const out = [];
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)); } while (value);
  return out;
};
const header = n => [77, 79, 85, 84, 1, ...varint(n)];
const frame = (n, mode, payload) => Uint8Array.from([...header(n), mode, ...varint(n), ...(mode ? varint(payload.length) : []), ...payload, 0, 0, 0, 0]);
const sandbox = { require, module: { exports: {} }, Uint8Array, Int32Array, Uint32Array, Uint16Array, Buffer, process, console };
vm.runInNewContext(fs.readFileSync(path.join(root, 'middleout.js'), 'utf8') + '\nmodule.exports.internals = { BitWriter, BitReader, writeNum, readNum, encodeMiddleOut, decodeMiddleOut, suffixArray, bwtForward, bwtInverse, decodeBlock, writeBounded, readBounded };', sandbox);
const internals = sandbox.module.exports.internals;
const payload = (primary, rows, symbols) => {
  const writer = new internals.BitWriter(64);
  internals.writeNum(writer, primary);
  rows.forEach(row => internals.writeNum(writer, row));
  writer.write(symbols.length - 1, 8);
  for (const [symbol, count] of symbols) { writer.write(symbol, 8); internals.writeNum(writer, count); }
  return writer.finish();
};

for (const fixture of require('./v1-fixtures.json')) test(`original v1 ${fixture.name}`, () => {
  const input = Buffer.from(fixture.input, 'base64');
  equal(decompress(Buffer.from(fixture.packed, 'base64')), input);
  equal(decompress(compress(input)), input);
});

for (const n of [0, 1, 2, 4, 5, 6, 7, 8, 9, 15, 16, 17, 127, 128, 255, 256, 4095, 4096, 4097, 65535, 65536, 65537]) {
  for (const input of [random(n), Buffer.alloc(n, 255), Buffer.from(Array.from({ length: n }, (_, i) => i % 11))]) {
    for (const blockSize of [97, 4096, 16777215]) test(`round trip ${n}/${blockSize}`, () => {
      const original = Buffer.from(input);
      const packed = compress(input, { blockSize });
      equal(decompress(packed), input);
      equal(input, original);
      equal(compress(input, { blockSize }), packed);
    });
  }
}
for (let i = 0; i < 300; i++) test(`randomized ${i}`, () => {
  const input = random((i * 719) % 12000);
  const alphabet = 1 + (i % 256);
  for (let j = 0; j < input.length; j++) input[j] %= alphabet;
  equal(decompress(compress(input, { blockSize: 1 + (i * 997) % 15000 })), input);
});
for (const input of [Buffer.from('ação café 日本語 🧪\n'.repeat(3000)), fs.readFileSync(process.execPath).subarray(0, 65536), zlib.gzipSync(random(65536))]) test('representative inputs', () => equal(decompress(compress(input)), input));
test('large multi-block', () => {
  const input = Buffer.alloc(17 * 1024 * 1024, 128);
  equal(decompress(compress(input)), input);
});
for (const value of [null, {}, 'hello', [1], new Uint16Array(2)]) test('input type', () => {
  assert.throws(() => compress(value), TypeError);
  assert.throws(() => decompress(value), TypeError);
});
for (const blockSize of [NaN, Infinity, -1, 0, '5']) test('block option', () => assert.throws(() => compress(Buffer.alloc(2), { blockSize }), RangeError));
for (const maxOutputLength of [NaN, Infinity, -1, 1.5, '5']) test('output limit option', () => assert.throws(() => decompress(compress(Buffer.alloc(0)), { maxOutputLength }), RangeError));
for (const maxBlockSize of [0, -1, 16777216, 1.1]) test('block limit option', () => assert.throws(() => decompress(compress(Buffer.alloc(0)), { maxBlockSize }), RangeError));
test('resource limits', () => {
  const packed = compress(Buffer.alloc(10000));
  assert.throws(() => decompress(packed, { maxOutputLength: 9999 }), /maxOutputLength/);
  assert.throws(() => decompress(packed, { maxBlockSize: 9999 }), /metadata/);
  equal(decompress(packed, { maxOutputLength: 10000, maxBlockSize: 10000 }), Buffer.alloc(10000));
  assert.throws(() => decompress(Uint8Array.from(header(268435457))), /maxOutputLength/);
  assert.throws(() => decompress(Uint8Array.from(header(268435456))), /truncated/);
  equal(decompress(compress(Buffer.alloc(0)), { maxOutputLength: 0 }), Buffer.alloc(0));
});
for (const bytes of [[...header(0), 0, 0, 0, 0, 1], [77,79,85,84,1,128,0,0,0,0,0], [77,79,85,84,1,...Array(20).fill(255)], [...header(1),3,1,0,0,0,0], [...header(1),0,0,0,0,0,0], [...header(1),1,1,...varint(Number.MAX_SAFE_INTEGER),0,0,0,0]]) test('bad framing', () => assert.throws(() => decompress(Uint8Array.from(bytes))));
for (const input of [Buffer.alloc(0), Buffer.from('abracadabra '.repeat(500)), random(64)]) {
  const packed = compress(input);
  for (let i = 0; i < packed.length; i++) test(`truncated ${i}`, () => assert.throws(() => decompress(packed.subarray(0, i))));
  test('trailing bytes', () => assert.throws(() => decompress(Buffer.concat([packed, Buffer.from([0])])), /trailing/));
  for (let i = 0; i < packed.length; i++) for (let bit = 0; bit < 8; bit++) test('bit corruption', () => {
    const bad = packed.slice(); bad[i] ^= 1 << bit;
    assert.throws(() => decompress(bad));
  });
}
test('bitreader bounds and widths', () => {
  assert.throws(() => new internals.BitReader(new Uint8Array(0)).read(1), /truncated/);
  assert.throws(() => internals.readNum(new internals.BitReader(Uint8Array.of(248))), /width/);
});
test('symbol validation', () => {
  assert.throws(() => internals.decodeBlock(1, payload(8, [], [[1, 4], [1, 4]]), 8), /duplicate/);
  assert.throws(() => internals.decodeBlock(1, payload(8, [], [[1, 7]]), 8), /corrupt/);
  assert.throws(() => internals.decodeBlock(1, payload(8, [], [[1, 0]]), 8), /corrupt/);
});
test('BWT metadata and payload termination', () => {
  const good = payload(8, [], [[1, 8]]);
  equal(internals.decodeBlock(1, good, 8), Buffer.alloc(8, 1));
  assert.throws(() => internals.decodeBlock(1, payload(7, [], [[1, 8]]), 8), /primary/);
  assert.throws(() => internals.decodeBlock(1, payload(0, [], [[1, 8]]), 8), /corrupt/);
  assert.throws(() => internals.decodeBlock(1, Buffer.concat([good, Buffer.from([0])]), 8), /trailing/);
  const bad = payload(7, [], [[1, 7]]).slice(); bad[bad.length - 1] |= 1;
  assert.throws(() => internals.decodeBlock(1, bad, 7), /trailing/);
  assert.throws(() => internals.decodeBlock(1, payload(4096, Array(7).fill(1), [[1,4096]]), 4096), /chains/);
  assert.throws(() => internals.decodeBlock(1, payload(4096, Array(7).fill(0), [[1,4096]]), 4096), /corrupt/);
});
for (let n = 1; n < 150; n++) test('suffix array oracle', () => {
  const input = random(n);
  for (let i = 0; i < n; i++) input[i] %= 7;
  const symbols = new Uint16Array(n + 1);
  for (let i = 0; i < n; i++) symbols[i] = input[i] + 1;
  const actual = new Int32Array(n + 1);
  internals.suffixArray(symbols, actual, n + 1, 257);
  const expected = Array.from({ length: n + 1 }, (_, i) => i).sort((a,b) => Buffer.compare(input.subarray(a), input.subarray(b)));
  assert.deepStrictEqual(Array.from(actual), expected);
  const { L, primary, rows } = internals.bwtForward(input);
  equal(internals.bwtInverse(L, n, primary, rows), input);
});
for (let range = 1; range <= 1024; range++) test('bounded integer oracle', () => {
  const writer = new internals.BitWriter(64);
  const values = [0, Math.floor((range - 1) / 2), range - 1];
  for (const value of values) internals.writeBounded(writer, value, range);
  const reader = new internals.BitReader(writer.finish());
  for (const value of values) assert.strictEqual(internals.readBounded(reader, range), value);
});
for (let i = 0; i < 200; i++) test('interpolative list oracle', () => {
  const n = 1 + i * 17;
  const positions = [];
  for (let j = 0; j < n; j++) if ((j * 31 + i) % 13 < i % 14) positions.push(j);
  const writer = new internals.BitWriter(64);
  internals.encodeMiddleOut(writer, positions, 0, positions.length - 1, 0, n - 1);
  const restored = new Int32Array(positions.length);
  internals.decodeMiddleOut(new internals.BitReader(writer.finish()), restored, 0, restored.length - 1, 0, n - 1);
  assert.deepStrictEqual(Array.from(restored), positions);
});
test('exact stored fallback cost', () => {
  assert.strictEqual(compress(Buffer.alloc(6, 97)).length, 17);
  assert.strictEqual(compress(Buffer.alloc(7, 97)).length, 17);
  assert.strictEqual(compress(Buffer.alloc(8, 97)).length, 17);
});
for (let i = 0; i < 300; i++) test('malformed input fuzz', () => {
  const bad = random(i % 256);
  if (i % 2 === 0 && bad.length >= header(i * 5).length) bad.set(header(i * 5));
  try { const result = decompress(bad, { maxOutputLength: 65536 }); assert(result.length <= 65536); }
  catch (error) { assert(error instanceof Error); }
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-test-'));
try {
  const cli = args => spawnSync(process.execPath, [path.join(root, 'middleout.js'), ...args], { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'input'), 'abracadabra '.repeat(100));
  test('CLI round-trip and overwrite protection', () => {
    assert.strictEqual(cli(['c','input']).status, 0);
    const before = fs.readFileSync(path.join(dir,'input.mo'));
    assert.strictEqual(cli(['c','input']).status, 1);
    equal(fs.readFileSync(path.join(dir,'input.mo')), before);
    assert.strictEqual(cli(['c','input','--force']).status, 0);
    assert.strictEqual(cli(['d','input.mo','restored']).status, 0);
    equal(fs.readFileSync(path.join(dir,'input')), fs.readFileSync(path.join(dir,'restored')));
  });
  for (const args of [['c','missing'], ['c','input','input','--force'], ['c','input','--unknown'], ['c','input','--block=1junk'], ['c','input','--block='], ['c','input','--block=Infinity'], ['c','input','--block=1','--block=2'], ['d','input.mo','limited','--max-output=0.0001'], ['d','input.mo','--block=1'], ['test','extra'], ['c','input','one','two']]) test('CLI failure', () => {
    const result = cli(args); assert.strictEqual(result.status, 1); assert(!result.stderr.includes('at main'));
  });
  test('CLI help', () => assert.strictEqual(cli(['--help']).status, 0));
  test('same inode protection', () => {
    fs.linkSync(path.join(dir,'input'),path.join(dir,'alias'));
    assert.strictEqual(cli(['c','input','alias','--force']).status, 1);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

if (process.env.MIDDLEOUT_V1_MODULE) test('bidirectional original interoperability', () => {
  const original = require(path.resolve(process.env.MIDDLEOUT_V1_MODULE));
  for (const n of [6, 7, 8, 4095, 4096, 4097]) equal(original.decompress(compress(Buffer.alloc(n, 97))), Buffer.alloc(n, 97));
  for (let i = 0; i < 100; i++) {
    const input = i % 2 ? random(i * 113) : Buffer.from('test interoperability '.repeat(i * 10));
    for (const blockSize of [97, 4096, 16777215]) {
      equal(original.decompress(compress(input, { blockSize })), input);
      equal(decompress(original.compress(input, { blockSize })), input);
    }
  }
});
console.log(`OK: ${checks} regression, property, security, compatibility and CLI checks`);
