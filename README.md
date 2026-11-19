# middleout

MiddleOut is a lossless, zero-dependency compressor distributed as one JavaScript file. It combines a Burrows–Wheeler transform (BWT), optional move-to-front (MTF), and binary interpolative coding of symbol positions. The name refers to the middle-first traversal used by the position coder.

It favors repetitive data. It is not a general replacement for gzip, bzip2, xz, zstd or Brotli: both ratio and speed depend strongly on the input. Compression is synchronous, and random input remains expensive to analyze even when it ultimately falls back to storage.

## Install

```sh
npm install @dnisdev666/middleout
npm install -g @dnisdev666/middleout
npx @dnisdev666/middleout --help
```

Requires Node.js 16 or newer; use a maintained Node.js release for production. You can also copy `middleout.js` directly. There are no runtime or development dependencies. Repository tests are configured for Node 16, 18, 20, 22 and 24 on Linux and Windows, and 18–24 on macOS.

## CLI

```text
middleout c <file> [out]       compress; default output: <file>.mo
middleout d <file> [out]       decompress; remove .mo or append .out
middleout bench <file>...     compare compressors, verifying each round-trip
middleout test                built-in round-trip and corruption tests

--block=<MiB>       compression block size; default 16, capped at 16,777,215 bytes
--max-output=<MiB>  decompression output limit; default 256 MiB
--force            replace an existing output
--help             show usage
--                 treat following arguments as positional filenames
```

```sh
middleout c notes.txt
middleout d notes.txt.mo restored.txt
middleout c --block=4 large.log
middleout d --max-output=1024 large.log.mo restored.log
middleout bench notes.txt
```

Output replacement requires `--force`. The input cannot also be the output, including a hard-link alias. Results are written to a temporary file in the destination directory, then published using an exclusive hard link or, with `--force`, a rename. This avoids truncating an existing file if compression or writing fails. The destination filesystem must support these operations. Errors go to stderr with exit status 1; help and successful operations return 0.

## Library

```js
const { compress, decompress } = require('@dnisdev666/middleout');

const input = Buffer.from('lossless data');
const packed = compress(input, { blockSize: 4 * 1024 * 1024 });
const restored = decompress(packed, {
  maxOutputLength: 256 * 1024 * 1024,
  maxBlockSize: 16777215,
});
```

Both functions accept a `Buffer` or `Uint8Array` and return a `Uint8Array`. They do not modify their inputs. All API sizes are bytes.

- `compress(input, { blockSize })`: defaults to 16,777,215. A positive finite number is rounded down and clamped to `[1, 16777215]`; invalid values throw.
- `decompress(input, { maxOutputLength, maxBlockSize })`: defaults to 256 MiB of output and 16,777,215 bytes per block. The output limit must be a nonnegative safe integer; the block limit must be an integer in `[1, 16777215]`. Raise the output limit explicitly for larger trusted files.

The default output limit is a new resource policy, not a format change. Existing large v1 files remain readable with a sufficient explicit limit. Invalid options, malformed input, resource-limit violations and checksum mismatches throw. Whole input and output are held in memory; there is no streaming API.

## Compression pipeline

1. Split the input into bounded blocks. Blocks of four bytes or fewer are stored directly.
2. Build the BWT using SA-IS over a unique sentinel. The top-level symbol workspace uses 16-bit entries; suffix indices and recursively named symbols retain 32-bit entries. Uniform blocks have a direct construction that avoids suffix sorting.
3. Encode both direct BWT bytes and MTF ranks, choosing the smaller payload. Uniform blocks need only the direct candidate. The MTF candidate can reuse its sequence workspace; the direct candidate preserves the BWT for MTF.
4. Count symbols, sort by decreasing frequency (byte value breaks ties), and encode each symbol's positions among the remaining bytes. Encode the complement when it is smaller. Binary interpolative coding visits the midpoint recursively; contiguous position ranges need no bits. The final symbol fills all remaining gaps.
5. Compare the actual coded payload plus its varint length against raw storage. Append a CRC-32 of the original input.

Decompression reverses these steps. Position workspace is sized to the number of entries actually encoded, MTF decoding runs in place, and uniform BWT inversion avoids the LF-mapping allocation. Large BWT blocks use eight interleaved chains; their endpoints are validated.

SA-IS is linear, but the position coder repeatedly scans the remaining sequence, up to 255 passes for a byte alphabet. This and MTF make high-entropy inputs costly. There is no speculative incompressibility shortcut: both candidates are compared exactly, preserving compression choices.

## Format v1 and integrity

The writer still emits version 1. The decoder supports files produced by the original implementation, and the original decoder can read new output. No new modes or coding conventions were introduced.

```text
file        = "MOUT" version total_len block* crc32
version     = 0x01
block       = mode block_len [payload_len] payload
mode        = 0 (stored), 1 (BWT/direct), 2 (BWT/MTF)
block_len   = uncompressed bytes, 1 … 16,777,215
payload_len = coded bytes, present only in modes 1 and 2
crc32       = IEEE CRC-32 of the entire uncompressed input, 4 bytes little-endian
```

Lengths use minimal unsigned base-128 varints, least-significant group first. The high bit indicates continuation. Blocks account for exactly `total_len`; exactly four checksum bytes must remain.

Coded payloads are packed most-significant bit first:

1. BWT primary row, in `[1, block_len]`.
2. Seven chain-start rows when `block_len >= 4096`.
3. Eight bits for the distinct-symbol count minus one, then each symbol's eight-bit value and positive frequency. Frequencies sum to `block_len`, and symbols cannot repeat.
4. Interpolative position lists for every symbol except the last.

Numbers in this bitstream use five bits for their binary width, followed by the value **without its leading one**; zero has width zero, and one has width one with no value bits. Widths are at most 24. Bounded integers use truncated binary coding. Final unused bits are zero; additional payload bytes are invalid. The format describes a sentinel-based suffix transform, not a cyclic-rotation sort without a sentinel.

The decoder validates framing before allocating the output, bounds varints and bit reads, checks symbol tables and BWT metadata, enforces resource limits, and rejects trailing file bytes and nonzero padding. These stricter rules reject malformed streams the previous decoder sometimes accepted.

CRC-32 detects accidental corruption; it is not authentication and cannot guarantee detection of every modification. An attacker can recompute it. Authenticate files separately when required. Resource limits bound output and block sizes, not wall-clock execution time or total process RSS; use worker/process isolation and a smaller block limit for hostile workloads. Memory also includes the compressed input, output, temporary arrays, runtime and garbage collector. This format is not a substitute for a backup.

## Tests and benchmarks

From a repository checkout:

```sh
npm test
npm run benchmark -- --iterations=5
npm run benchmark -- --block=4194304 --iterations=5 path/to/corpus/*
node scripts/benchmark.js --codecs=middleout,gzip-6 --iterations=5 path/to/file
```

The original 1,644 round-trips and 200 corruption checks remain. The regression suite adds original v1 fixtures for all modes, deterministic randomized inputs, UTF-8, executable and gzip bytes, block boundaries, a 17 MiB multi-block case, suffix-array and integer-coding oracles, exhaustive single-bit changes and truncation of small files, malformed headers/payloads, resource limits, input immutability and CLI behavior.

For bidirectional compatibility against a saved original implementation:

```sh
git show bf3d254:middleout.js > /tmp/middleout-v1.js
MIDDLEOUT_V1_MODULE=/tmp/middleout-v1.js npm test
node scripts/benchmark.js --module=/tmp/middleout-v1.js --codecs=middleout --iterations=5
```

`middleout bench` works from the single-file distribution: one full-input warm-up, three measured round-trips, median encode/decode times and encode range. It uses Node zlib for gzip/Brotli and zstd when available; otherwise zstd, bzip2 and xz require their executables on `PATH`. Missing executables are reported, other failures stop the benchmark.

`scripts/benchmark.js` provides the reproducible JSONL workflow. Each codec/dataset runs in a fresh worker with one full-input warm-up and configurable measured iterations. Every round-trip is checked. Rows include input SHA-256, compressed bytes, ratio (`input/output`), median/min/max times, throughput and peak RSS. Metadata records runtime, platform, CPU, codec versions, block size and iteration count.

The default datasets are deterministic uniform bytes, periodic data, repeated UTF-8 text, generated JSON records, pseudorandom bytes, gzip of those pseudorandom bytes, and the first MiB of the running Node executable. The executable depends on the Node build; hashes identify the actual data. These are diagnostic datasets, **not a substitute for a representative corpus**. Supply local Silesia files as positional arguments to test that corpus. No Silesia measurements were repeated in this audit, and the previous undocumented Silesia claims are not treated as current results.

For Node codecs, RSS is the worker's high-water mark across warm-up and both operations, including input, runtime and GC. For external codecs, `/usr/bin/time` supplies the maximum child RSS on macOS/Linux when available, otherwise null. Those memory scopes differ and must not be ranked as equivalent. External timing includes process startup and pipe transfers. Compression levels are explicit: gzip 6, bzip2 9, xz 6, zstd 19 and Brotli 11; external xz/zstd compression uses one thread. Avoid other CPU-heavy work while measuring.

## Measured results

Measured on 2026-11-19, Apple M3, macOS arm64, Node 23.5.0. Baseline: commit `bf3d254` (package 1.0.2). One warm-up and five measured iterations per codec/input, run sequentially. Times below are medians in milliseconds; RSS is MiB. These local results are not performance guarantees. Min/max timing ranges and hashes are retained in the JSONL output.

| Input | Input bytes | Output bytes, old → new | Encode ms, old → new | Decode ms, old → new | Peak RSS MiB, old → new |
|---|---:|---:|---:|---:|---:|
| repeated | 1,048,576 | 46 → 46 | 41.24 → 3.90 | 9.18 → 3.25 | 96.9 → 64.7 |
| periodic | 1,050,000 | 115 → 115 | 44.60 → 42.43 | 9.83 → 9.02 | 95.2 → 93.1 |
| text | 984,000 | 304 → 304 | 48.73 → 54.32 | 8.34 → 8.28 | 97.3 → 96.7 |
| structured | 553,480 | 27,376 → 27,376 | 33.78 → 33.52 | 7.83 → 8.33 | 88.3 → 88.8 |
| random | 262,144 | 262,160 → 262,160 | 141.07 → 141.73 | 0.60 → 0.62 | 80.9 → 76.7 |
| gzip | 262,242 | 262,258 → 262,258 | 138.49 → 141.23 | 0.60 → 0.62 | 82.0 → 76.0 |
| executable | 1,048,576 | 299,892 → 299,892 | 148.62 → 154.69 | 42.14 → 41.88 | 99.4 → 99.0 |
| large-text | 8,710,000 | 299 → 299 | 739.49 → 545.68 | 80.82 → 83.22 | 242.5 → 244.0 |

Compression ratios were unchanged on these datasets: for example, structured JSON remained 20.22× and the executable 3.50×. Seven identical bytes now occupy 17 bytes instead of 19 (ratio 0.368× → 0.412×), due to exact framing-cost selection. This is a small-block improvement, not a broad density gain. No new entropy coder or format version was justified.

Uniform-block compression improved substantially. Other timings are mixed: this run showed slower compression on the 984 kB text sample and a small executable slowdown, while the larger repeated-text sample improved. Peak RSS did not consistently fall on nonuniform data despite smaller individual workspaces; GC and retained allocations affect the process high-water mark. Do not infer a universal speedup or fixed RAM multiplier.

The `large-text` input is 8,710,000 bytes of a repeated UTF-8 sentence. With 1 MiB blocks it produced 2,347 bytes, versus 817 with 4 MiB blocks and 299 with the default block limit. Smaller blocks traded density for speed here; the default remains unchanged.

Comparison with established codecs on the same generated JSON and executable slice:

| Codec | JSON bytes | JSON encode / decode ms | Executable bytes | Executable encode / decode ms |
|---|---:|---:|---:|---:|
| middleout | 27,376 | 33.52 / 8.33 | 299,892 | 154.69 / 41.88 |
| gzip-6 | 65,292 | 4.72 / 0.37 | 345,979 | 22.70 / 1.55 |
| bzip2-9 | 28,996 | 33.99 / 9.66 | 298,631 | 49.26 / 22.79 |
| xz-6 | 15,584 | 117.06 / 6.79 | 212,236 | 151.35 / 14.44 |
| zstd-19 | 26,475 | 204.04 / 5.68 | 252,093 | 166.53 / 6.65 |
| brotli-11 | 18,931 | 573.64 / 0.50 | 227,998 | 1482.09 / 2.39 |

Ascending-frequency symbol ordering was tested and rejected: it increased the executable output from 299,892 to 315,579 bytes and made encoding/decoding substantially slower. Reusing the direct BWT sequence required moving MTF earlier and showed a compression slowdown; the final implementation preserves the direct sequence and only reuses the MTF buffer. A CPU profile of the original large repeated-text case placed most samples in suffix-array construction/induction, followed by sequence encoding. The narrower top-level symbols and uniform fast path address those measured costs.

## Credits and license

- M. Burrows and D. J. Wheeler, *A Block-sorting Lossless Data Compression Algorithm*, DEC SRC Research Report 124, 1994.
- G. Nong, S. Zhang and W. H. Chan, *Two Efficient Algorithms for Linear Time Suffix Array Construction*, IEEE Transactions on Computers, 2011 (first presented at DCC 2009).
- A. Moffat and L. Stuiver, *Binary Interpolative Coding for Effective Index Compression*, Information Retrieval 3(1), 2000.
- J. L. Bentley, D. D. Sleator, R. E. Tarjan and V. K. Wei, *A Locally Adaptive Data Compression Scheme*, CACM, 1986.
- S. Deorowicz's [Silesia corpus](https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia) is an optional external benchmark dataset.

The name is a reference to HBO's *Silicon Valley*; this project is not affiliated with or endorsed by its creators. No Weissman score is used as an engineering metric.

[MIT](LICENSE).
