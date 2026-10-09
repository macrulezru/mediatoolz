# **MediaToolz**

![MediaToolz](https://github.com/macrulezru/assets/blob/master/packages-images/mediatoolz.webp?raw=true)

A small toolbox of CLI commands for images: resize, convert and recompress
them in bulk by rules, and generate compact placeholders for them. One
binary, one subcommand per job, each safe by default (a preview first, a
backup before anything is overwritten).

It started as part of [devtoolz](https://www.npmjs.com/package/@macrulez/devtoolz)
and lives in its own package since devtoolz 0.5.0.

## Features

- **`image-hash`** — generates [hazehash](https://github.com/macrulezru/hazehash),
  [blurhash](https://blurha.sh) and/or
  [thumbhash](https://evanw.github.io/thumbhash/) placeholders for raster
  images (jpg, png, webp, gif, avif, tiff). Takes files and/or
  directories — several of each, comma-separated too — and `-r` walks
  subdirectories. Prints to stdout by default; `-o <file>` collects
  everything into one file, `--per-file` / `--out-dir <dir>` writes a
  file per image (`photo.jpg` → `photo.jpg.blurhash.txt`, with
  `--suffix` and `--out-ext` to rename). Formats: `json`, `plain` (just
  the hash text, no newline), `csv`, and `ts`/`js` modules you can import
  straight into the app. Without `-t` it makes blurhash and thumbhash; `-t hazehash` adds the
  more compact and more accurate hazehash (`--budget` sets its size in
  bytes, 28 by default). Besides the hashes it can produce the
  dominant color and a tiny PNG preview (`-t all`), accepts `http(s)`
  URLs and path lists from a file or stdin, and can keep an output file in
  sync: `--cache` skips unchanged images, `--update --prune` merges into
  the existing file, `--check` fails with exit code 1 when it is stale
  (made for CI). `--dry-run` writes nothing and shows the result as a
  table instead. Uses the native `sharp` library, which comes
  with the package — see Requirements.
- **`image-batch`** — produces resized, converted and recompressed versions
  of raster images in bulk, by rules kept in a reusable **config** or given
  as flags: `widths`, `heights`, `size`, `longEdge` / `shortEdge` (the same for
  landscape and portrait), `megapixels`, `percent`, `scale` (`@2x`),
  `matchOrientation`, `maxBytes` (`--max-size 200KB` lowers the quality as far
  as needed), `formats` (jpg,
  png, webp, avif, gif, tiff, heif or `original`), `fit` (`inside`,
  `cover`, `contain`, …), codec options (`quality` as a number or a level
  `low`/`medium`/`high`/`best`, `mozjpeg`, a png `palette`, webp `lossless`,
  avif `effort`, …) and file names from a template
  (`{dir}/{name}-{width}w.{format}`, with `{ext}`, `{index:3}`, `{hash}`,
  `{scale}`, `{date}`). The config holds only the rules; the folders are
  chosen on every run. Where the results go is one of three: `-o <dir>` — a
  separate folder that repeats the source structure (`--flat` drops it);
  `--beside` — next to each source; `--replace` — over the sources
  themselves, each in its own format, to shrink oversized originals or
  recompress them in place. `--replace` is guarded: it asks for
  confirmation (`--yes` without a terminal), copies the originals to
  `.image-batch-backup/<date>/` first with a `journal.json`, replaces a file
  only if the result is smaller, never processes the same file twice with
  the same settings, and `--dry-run` shows the real before/after sizes;
  `image-batch restore <backup>` puts the originals back. Without a size
  flag it only converts the format. `-r` walks
  subfolders, `-i/--select` ticks files from an interactive list, `--list`
  only prints them. A result an earlier run already made is skipped; any
  other existing file is a conflict — a terminal asks once (overwrite this
  / this and all next / skip / skip all / quit), without a terminal it is
  skipped with exit code 1, or use `--overwrite`, `--skip-existing`,
  `--no-overwrite`. `--hazehash` (`--budget`), `--blurhash`, `--thumbhash`,
  `--dominant-color` with `--emit <file>` write a manifest of everything
  produced, with the placeholders. `init` creates configs, and `config` shows, edits,
  copies and deletes them (`.mediatoolz/image-batch/` in the project or
  `~/.mediatoolz/image-batch/` for all projects). `sharpen` adds output
  sharpening after the resize — by target and amount, with `radius`,
  `flat`, `jagged` and `threshold` for fine control — and `image-batch
sharpen` saves such settings as presets that configs and `--sharpen <name>`
  use by name. Uses `sharp` too — see
  Requirements.
- **`ui`** — starts a local web interface and opens it in the browser, so the
  commands can be run with forms, tables and previews instead of flags. Two
  modules: **Image Hash** (a gallery of the placeholders decoded next to each
  image) and **Image Batch** (convert, edit configs and sharpening presets with
  a before and after preview, restore backups). It is part of the package,
  listens on `127.0.0.1` only behind a one-time token, and writes nothing
  without an explicit choice. `--port`, `--no-open`, `--cwd`.

`image-hash` writes files only when you name an output (`-o`, `--per-file`,
`--out-dir`) and prints to stdout otherwise; `image-batch` writes into the
folder given with `-o`, next to the sources with `--beside`, and over them
only with `--replace` — after a confirmation, with a backup. Every command
supports `--json` for machine-readable output.

## Requirements

- Node.js 20+
- The [`sharp`](https://sharp.pixelplumbing.com) image library comes with
  the package: npm picks its prebuilt binary for your platform during the
  install, so there is nothing to set up. Only if that binary is missing
  (an install with `--omit=optional`, an unsupported platform) does the
  first run offer to install `sharp` into `~/.mediatoolz/deps` (`-y` /
  `--yes` agrees up front, which is also what you want in CI; without a
  terminal and without `--yes` the command stops and says so).

## Installation

```bash
npm install -g @macrulez/mediatoolz
```

Or run it without installing:

```bash
npx @macrulez/mediatoolz image-batch ./photos -r -o ./out -f webp
```

## Quick start

```bash
mediatoolz image-hash public/img                 # blurhash + thumbhash of every image, as JSON on stdout
mediatoolz image-hash public/img -r -t hazehash --budget 24 -o hashes.json   # hazehash of 24 bytes at most
mediatoolz image-hash a.jpg,b.png,photos -r -t blurhash -f csv -o hashes.csv
mediatoolz image-hash public/img -r -f plain --per-file   # photo.jpg.blurhash.txt + photo.jpg.thumbhash.txt
mediatoolz image-hash public/img -r -f ts -t thumbhash -o src/placeholders.ts --name placeholders
mediatoolz image-hash public/img -r --dry-run        # write nothing, show a table of the hashes
mediatoolz image-hash public/img -r -t all --components auto -o hashes.json --cache --update --prune
mediatoolz image-hash public/img -r -o hashes.json --check   # CI: exit 1 if hashes.json is stale

mediatoolz image-batch ./src/images -r -o ./public/images -w 400,800,1200 -f avif,webp,jpg -q high
mediatoolz image-batch ./photos -r -o ./out -c web             # apply the saved config "web"
mediatoolz image-batch ./photos -r -o ./out -c web --select    # tick the files from a list first
mediatoolz image-batch ./photos -r -o ./out -c web --dry-run   # show what would be written
mediatoolz image-batch ./photos -r -o ./out -c web --hazehash --budget 20 --emit ./out/images.json
mediatoolz image-batch ./photos -r -o ./out -f webp                   # only change the format, keep the size
mediatoolz image-batch ./photos -r -o ./out --long 1600 -f webp,jpg --max-size 200KB   # by long side, capped weight
mediatoolz image-batch ./assets -r --replace -w 1600 --dry-run    # preview shrinking originals in place
mediatoolz image-batch ./assets -r --replace -w 1600               # do it: backup first, asks to confirm
mediatoolz image-batch restore .image-batch-backup/20261007-233706  # put the originals back
mediatoolz image-batch ./photos -r --beside -w 400 -f webp         # results next to each source
mediatoolz image-batch init                      # create a config with a few questions
mediatoolz image-batch config                    # pick a config: apply, show, edit, copy, delete
mediatoolz image-batch sharpen new               # save a sharpening preset, then --sharpen <name>

mediatoolz ui                                  # web interface for both commands
mediatoolz ui --no-open --port 4477            # just print the address
```

Every command has built-in `--help` — `mediatoolz --help` lists both commands
with their own flags inline; `mediatoolz <command> --help` for one command's
full flag list with defaults.

## Development

```bash
npm install
npm run build      # tsc -> dist/, and the web interface
npm test           # vitest
npm run lint       # eslint .
npm run format     # prettier --check .
npm run typecheck  # tsc --noEmit
```

---

## Documentation & links

- 📖 **Full documentation:** [npm.vuecraft.ru/en/packages/mediatoolz](https://npm.vuecraft.ru/en/packages/mediatoolz/guide/overview.html)
- 🌐 **VueCraft:** [vuecraft.ru/en](https://vuecraft.ru/en)
- 👤 **Author:** [macrulez.ru/en](https://macrulez.ru/en)
- 💻 **GitHub:** [macrulezru/mediatoolz](https://github.com/macrulezru/mediatoolz)
- 📦 **NPM:** [@macrulez/mediatoolz](https://www.npmjs.com/package/@macrulez/mediatoolz)
- 🐛 **Issues:** [github.com/macrulezru/mediatoolz/issues](https://github.com/macrulezru/mediatoolz/issues)

---

## License

MIT

---

## 💖 Support the project

Open source takes time and effort. If this library saves you time or brings value, consider supporting further development.

<a href="https://donate.cryptocloud.plus/M6O34NIN" target="_blank">
  <img src="https://img.shields.io/badge/Donate-CryptoCloud-8A2BE2?style=for-the-badge&logo=cryptocurrency&logoColor=white" alt="Donate via CryptoCloud">
</a>

Thank you for being part of this journey. ❤️
