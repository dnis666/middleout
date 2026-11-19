'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

function datasets() {
  let seed = 42;
  const random = Buffer.alloc(256 * 1024);
  for (let i = 0; i < random.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    random[i] = seed & 255;
  }
  const text = Buffer.from('The middle of a file is where compression begins. Lossless data: café 日本語.\n'.repeat(12000));
  const structured = Buffer.from(Array.from({ length: 10000 }, (_, i) => JSON.stringify({ id: i, kind: i % 17, active: !!(i % 3), name: `record-${i % 391}` }) + '\n').join(''));
  return { repeated: Buffer.alloc(1024 * 1024, 97), periodic: Buffer.from('abracadabra0123456789'.repeat(50000)), text, structured, random, gzip: zlib.gzipSync(random), executable: fs.readFileSync(process.execPath).subarray(0, 1024 * 1024) };
}

function codec(name, modulePath, blockSize) {
  if (name === 'middleout') {
    const mo = require(modulePath);
    return [data => mo.compress(data, { blockSize }), data => mo.decompress(data)];
  }
  if (name === 'gzip-6') return [data => zlib.gzipSync(data, { level: 6 }), data => zlib.gunzipSync(data)];
  if (name === 'brotli-11') return [data => zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), data => zlib.brotliDecompressSync(data)];
  if (!['bzip2-9', 'xz-6', 'zstd-19'].includes(name)) throw new Error(`unknown codec: ${name}`);
  const [cmd, level] = name.split('-');
  let peakRssKiB = null;
  const timed = ['darwin', 'linux'].includes(process.platform) && fs.existsSync('/usr/bin/time');
  const run = (data, decode) => {
    const args = decode ? ['-d', '-c'] : [`-${level}`, '-c'];
    if (cmd === 'xz') args.push('-T1');
    if (cmd === 'zstd') args.push('-q', '-T1');
    const result = timed
      ? spawnSync('/usr/bin/time', [process.platform === 'darwin' ? '-l' : '-v', cmd, ...args], { input: data, maxBuffer: 512 * 1024 * 1024 })
      : spawnSync(cmd, args, { input: data, maxBuffer: 512 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.toString());
    if (timed) {
      const stderr = result.stderr.toString();
      const match = process.platform === 'darwin' ? stderr.match(/(\d+)\s+maximum resident set size/) : stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
      if (match) peakRssKiB = Math.max(peakRssKiB || 0, Number(match[1]) / (process.platform === 'darwin' ? 1024 : 1));
    }
    return result.stdout;
  };
  return [data => run(data, false), data => run(data, true), () => peakRssKiB];
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
}

if (process.argv[2] === '--worker') {
  const [name, file, modulePath, block, iterations] = process.argv.slice(3);
  try {
    const data = fs.readFileSync(file);
    const [compress, decompress, childPeak] = codec(name, modulePath, Number(block));
    const warm = compress(data);
    if (!Buffer.from(decompress(warm)).equals(data)) throw new Error('warm-up round-trip mismatch');
    const encodeMs = [], decodeMs = [];
    let packed;
    for (let i = 0; i < Number(iterations); i++) {
      let start = performance.now();
      packed = compress(data);
      encodeMs.push(performance.now() - start);
      start = performance.now();
      const back = decompress(packed);
      decodeMs.push(performance.now() - start);
      if (!Buffer.from(back).equals(data)) throw new Error('round-trip mismatch');
    }
    const external = !['middleout', 'gzip-6', 'brotli-11'].includes(name);
    process.stdout.write(JSON.stringify({ name, sha256: createHash('sha256').update(data).digest('hex'), inputBytes: data.length, bytes: packed.length, ratio: data.length / packed.length, encodeMs: stats(encodeMs), decodeMs: stats(decodeMs), peakRssKiB: external ? childPeak() : process.resourceUsage().maxRSS, memoryScope: external ? 'external codec process' : 'Node worker including input and both operations', encodeMiBs: data.length / 1048576 / (stats(encodeMs).median / 1000), decodeMiBs: data.length / 1048576 / (stats(decodeMs).median / 1000) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ name, error: error.message }));
    process.exitCode = 1;
  }
} else {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
  const modulePath = path.resolve(option('module', path.join(__dirname, '..', 'middleout.js')));
  const iterations = Number(option('iterations', '3'));
  const block = Number(option('block', '16777215'));
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(block) || block < 1 || block > 16777215) throw new Error('invalid benchmark options');
  const names = option('codecs', 'middleout,gzip-6,bzip2-9,xz-6,zstd-19,brotli-11').split(',');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'middleout-bench-'));
  try {
    let files = args.filter(arg => !arg.startsWith('--'));
    if (!files.length) files = Object.entries(datasets()).map(([name, data]) => {
      const file = path.join(dir, name); fs.writeFileSync(file, data); return file;
    });
    console.log(JSON.stringify({ node: process.version, libraries: process.versions, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, modulePath, blockSize: block, iterations, warmups: 1, memory: 'Node worker peak RSS; external codec peak via /usr/bin/time when available; scopes differ', externalVersions: Object.fromEntries(['bzip2', 'xz', 'zstd'].map(cmd => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' }); return [cmd, r.error ? r.error.message : (cmd === 'bzip2' ? r.stderr : r.stdout || r.stderr).trim().split('\n')[0]] })) }));
    for (const file of files) if (!fs.statSync(file).isFile()) throw new Error(`not a regular file: ${file}`);
    for (const file of files) for (const name of names) {
      const result = spawnSync(process.execPath, [__filename, '--worker', name, file, modulePath, String(block), String(iterations)], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error;
      const row = result.stdout ? JSON.parse(result.stdout) : { name, error: result.stderr || `exit ${result.status}` };
      console.log(JSON.stringify({ dataset: path.basename(file), ...row }));
      if (row.error && !row.error.includes('ENOENT') && !row.error.includes('No such file or directory')) process.exitCode = 1;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
