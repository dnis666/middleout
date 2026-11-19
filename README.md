# middleout

**middleout** is a lossless compressor in a single JavaScript file. It has no dependencies and comes from a running joke: the "middle-out" algorithm in HBO's *Silicon Valley*. This one is real and works. It chains a Burrows–Wheeler transform, an optional move-to-front pass and a coding step that encodes byte positions from the middle out. On the Silesia corpus it compresses better than `bzip2 -9` and `zstd -19` and gets within about 4% of `xz -6`. It does this with no Huffman or arithmetic coder. Use it as a CLI, as a library, or copy the one file into your project.

> **Honest disclaimer.** This is *not* the algorithm from the show, and nobody has that algorithm. No lossless compressor can beat the entropy of its input. Random data stays random. Already-compressed files (JPEG, MP4, ZIP and so on) will not shrink, and a "Weissman score" is a TV joke, not a standard metric. This project borrows the name and the "middle-out" idea for one real coding step, nothing more. It is not affiliated with or endorsed by HBO or the show's creators.

---

## How it works

Compression runs in three stages on each block (16 MiB by default).

### 1. Burrows–Wheeler transform (BWT)

Picture every rotation of the block, sorted alphabetically. Now read off the last character of each rotation. The result is the BWT: a permutation of the input in which bytes that appeared in similar contexts end up next to each other. In English text, for example, the letters that come before "he" (mostly `t`, `s` and space) gather in long runs. The BWT does not shrink anything yet. It only makes the data much easier to code, and it can be inverted exactly.

The sorting is done with a **suffix array** built by **SA-IS** (induced sorting), which runs in linear time.

### 2. Move-to-front (optional)

Move-to-front replaces each byte with its position in a list of recently seen bytes, then moves that byte to the front of the list. Runs of the same byte turn into runs of zeros. MTF helps on some data and hurts on other data, so every block is coded **both with and without it** and the smaller result is kept.

### 3. Middle-out coding

This stage is where the name comes from. Instead of coding the bytes in order, the coder takes each byte value, most frequent first, and writes down **where** it occurs. It then deletes those bytes and repeats with what is left. The last value needs no list because it fills the remaining gaps.

Each sorted list of positions is coded **from the middle out**. The middle element is written first, then the middle of each half, and so on outwards. When an element is coded, both of its neighbours are already known, so it only costs about `log2(room between them)` bits. A gap-free run costs **zero** bits. If a value fills more than half of what remains, the coder lists the positions where it *doesn't* occur instead.

This technique is called **binary interpolative coding** (Moffat & Stuiver, 2000). After the BWT, the whole coder is just counting and bit packing.

---

## Install

The package name `@your-scope/middleout` below is a placeholder until it is published. See the [package name note](#package-name).

**npm (as a library or a global CLI):**

```bash
npm install @your-scope/middleout          # library
npm install -g @your-scope/middleout       # adds the `middleout` command
```

**npx (no install):**

```bash
npx @your-scope/middleout c bigfile.txt
```

**Or just download the single file.** `middleout.js` is self-contained, so copy it anywhere and run it with `node`:

```bash
curl -O https://raw.githubusercontent.com/your-github-user/middleout/main/middleout.js
node middleout.js test
```

Requires **Node.js 16 or newer**. It has been tested on Node 16, 18, 20, 22 and 24.

---

## CLI usage

```
middleout c <file> [out]       compress   (default out: <file>.mo)
middleout d <file> [out]       decompress (default out: <file> without .mo)
middleout bench <file>...      compare with gzip/bzip2/xz/zstd/brotli + Weissman score
middleout test                 round-trip self-test

Options:
  --block=<MiB>   block size in MiB (default 16, the maximum)
  --force         overwrite the output file if it exists
```

If you downloaded the file instead of installing the package, use `node middleout.js` in place of `middleout`.

Examples:

```bash
# compress, then restore to a new name and check it is identical
middleout c notes.txt                     # -> notes.txt.mo
middleout d notes.txt.mo restored.txt
cmp notes.txt restored.txt && echo identical

# smaller blocks use about half the RAM, at a small cost in ratio
middleout c --block=4 big.log big.log.mo --force

# compare against other compressors on your own files
middleout bench notes.txt big.log

# run the built-in self-test (1,644 round-trips + 200 corruption checks)
middleout test
```

Decompressing `notes.txt.mo` with no output name writes to `notes.txt`. If that file already exists, the command refuses to run unless you pass `--force`.

`bench` uses Node's built-in `zlib` for gzip and brotli, and for zstd when your Node version has it (`zlib.zstdCompressSync`, Node 22.15+ / 23.8+). It shells out to `bzip2` and `xz` when they are on your `PATH` and skips them when they are not.

---

## Library usage

```js
const fs = require('fs');
const { compress, decompress } = require('@your-scope/middleout'); // or require('./middleout.js')

const input = fs.readFileSync('notes.txt');      // Buffer or Uint8Array
const packed = compress(input);                  // Uint8Array
const smaller = compress(input, { blockSize: 4 * 1024 * 1024 }); // block size in BYTES

const restored = decompress(packed);             // Uint8Array, byte-exact
```

- `compress(buf, { blockSize })` takes a `Uint8Array` or `Buffer`. `blockSize` is in **bytes**, defaults to the maximum (16,777,215), and is clamped to `[1, 16777215]`. (The CLI's `--block` flag is in MiB.)
- `decompress(buf)` returns a `Uint8Array`. It throws on bad magic bytes, an unknown version, truncated input, corrupt data or a CRC-32 mismatch, so a damaged file is never silently decoded into wrong output.

Both functions are synchronous and work on the whole input in memory.

---

## Benchmarks

Full [Silesia corpus](https://sun.aei.polsl.pl/~sdeor/index.php?page=silesia): 12 files, 211,938,580 bytes. Each compressor ran single-threaded on one sandbox machine.

| Compressor | Compressed bytes | Ratio | Time | Weissman (vs gzip -6) |
|---|---:|---:|---:|---:|
| gzip -6 | 68,576,092 | 3.09 | 4.0 s | 1.00 |
| bzip2 -9 | 54,506,769 | 3.89 | 14.5 s | 1.09 |
| zstd -19 | 52,910,453 | 4.01 | 105.9 s | 0.93 |
| **middle-out** | **51,237,377** | **4.14** | 50.6 s | 1.03 |
| brotli -11 | 49,564,563 | 4.28 | 422.8 s | 0.89 |
| xz -6 | 49,233,340 | 4.30 | 105.3 s | 1.00 |

Notes from those runs:

- middle-out produced the **smallest output on 8 of 12 files**: `dickens`, `xml`, `mr`, `osdb`, `reymont`, `x-ray`, `nci` and `webster`.
- It beat `bzip2 -9` on **all 12** files.
- It lost to xz or brotli by **10–25%** on executables and mixed archives (`mozilla`, `ooffice`, `samba`, `sao`). BWT-based coders are weak on that kind of data.
- Per-file Weissman scores ranged from **0.75 to 1.42**.
- Speed was about **4 MiB/s to compress** and **13 MiB/s to decompress**.
- Peak RAM was about **400 MB** on a 41 MB file. `--block=4` roughly halves it.

Results depend on hardware, Node version and the versions of the external tools. Run `middleout bench <files>` to measure on your own machine.

---

## The Weissman score

The Weissman score is a metric invented for *Silicon Valley* to rate a compressor on both ratio and speed. It is not an industry standard, but it is fun and easy to compute:

```
W = α · (r / r_ref) · (log T_ref / log T)
```

- `r`, `r_ref`: compression ratio of the tested compressor and of a reference compressor
- `T`, `T_ref`: compression time of each, here in **milliseconds**
- `α`: a scaling constant, here **1**

`bench` uses `gzip -6` as the reference, so gzip always scores 1.00. A score above 1 means the extra ratio more than paid for the extra time on this log scale. Because of the logarithm, the score is very sensitive to the time unit and to very short runs. `bench` prints `n/a` when either time is 1 ms or less.

---

## Limitations

- **In memory.** The whole input file and the whole output are held in RAM. There is no streaming mode.
- **RAM usage.** Expect about 400 MB peak for large files at the default 16 MiB block size. Use `--block=4` (or `blockSize` in the library) to roughly halve it, at a small cost in ratio.
- **Experimental file format.** The `.mo` format is version 1 and may change. It has a CRC-32 and the decoder rejects damaged input, but it has not been battle-tested. **Don't keep the only copy of anything in it.**
- **Slower than gzip.** About 4 MiB/s to compress and 13 MiB/s to decompress, single-threaded. That is far slower than gzip and much faster than brotli -11, but not something you want in a hot path.
- **Weak on binaries and mixed archives.** xz and brotli beat it by 10–25% on executables and archives like `mozilla` or `ooffice`.
- **No miracles.** Random and already-compressed data will not shrink. Blocks that would grow are stored as-is, plus a few bytes of framing.

---

## File format

All multi-byte header integers are **varints**: 7 bits per byte, least significant group first, high bit set on every byte except the last.

```
file    = magic version total_len block* crc32
magic   = "MOUT"                     4 bytes: 4D 4F 55 54
version = 0x01                       1 byte
total_len = varint                   size of the original data
block   = mode block_len [payload_len] payload
  mode        = 1 byte: 0 = stored, 1 = BWT + direct, 2 = BWT + move-to-front
  block_len   = varint               uncompressed size of this block (1 … 16,777,215)
  payload_len = varint               only present when mode != 0
  payload     = block_len raw bytes (mode 0) or payload_len coded bytes
crc32   = 4 bytes, little-endian     CRC-32 (IEEE 802.3) of the whole original data
```

A coded payload is a bitstream written most significant bit first:

1. **BWT primary index.** A number written as 5 bits of length followed by the value bits.
2. **Chain start rows.** For blocks of 4,096 bytes or more, 7 more numbers in the same format. They let the decoder undo the BWT as 8 interleaved chains for speed.
3. **Symbol table.** 8 bits for (number of distinct byte values − 1). Then, for each value in order of decreasing frequency: 8 bits for the byte value and its count in the same number format.
4. **Position lists.** For every value except the last, its positions among the bytes still remaining, coded middle-out with binary interpolative coding. If the value is the majority of what remains, the complement is coded instead.

---

## Credits

This project assembles published techniques. The credit belongs to their authors:

- **Burrows–Wheeler transform.** M. Burrows and D. J. Wheeler, *A Block-sorting Lossless Data Compression Algorithm*, DEC SRC Research Report 124, 1994.
- **SA-IS suffix array construction.** G. Nong, S. Zhang and W. H. Chan, *Two Efficient Algorithms for Linear Time Suffix Array Construction*, IEEE Transactions on Computers, 2011 (first presented at DCC 2009).
- **Binary interpolative coding.** A. Moffat and L. Stuiver, *Binary Interpolative Coding for Effective Index Compression*, Information Retrieval 3(1), 2000.
- **Move-to-front.** J. L. Bentley, D. D. Sleator, R. E. Tarjan and V. K. Wei, *A Locally Adaptive Data Compression Scheme*, CACM, 1986.
- **Silesia corpus.** S. Deorowicz, Silesian University of Technology, used for the benchmarks above.
- The name and the Weissman score are a nod to HBO's *Silicon Valley*. They are used for parody and commentary only.

---

## Package name

`middleout` is free on npm right now (`npm view middleout` returns 404). However, npm rejects new names that only differ from an existing package by punctuation, and [`middle-out`](https://www.npmjs.com/package/middle-out) already exists. That is why the package uses the scoped placeholder `@your-scope/middleout`. Unscoped alternatives that were free when checked include `middleout-bwt` and `middleout-compress`.

## License

[MIT](LICENSE)
