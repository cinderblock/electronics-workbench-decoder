# Electronics Workbench Decoder and Encoder

Interop tools for Electronics Workbench / Multisim / Ultiboard binary
formats. The goal: get designs and part databases out of EW into
mainstream representations (and back, where the format permits).

- **`ewd`** — decode an EW file into JSON or XML, picking the right
  decoder by reading the file's magic bytes.
- **`ewe`** — encode the text-form back into an EW binary the original
  software can re-open. Currently supports compressed-XML; `.prj` Jet
  database encode is deferred (see below).

## Supported formats

| Key        | Extension(s)       | Kind             | Decode output    |
| ---------- | ------------------ | ---------------- | ---------------- |
| `ewprj`    | `.ewprj`           | `compressed-xml` | `<file>.xml`     |
| `multisim` | `.ms10` … `.ms19`  | `compressed-xml` | `<file>.xml`     |
| `mdb`      | `.prj`, `.usr`     | `mdb`            | `<file>.json`    |
| `ewnet`    | `.ewnet`           | `ewnet`          | `<file>.json`    |

### compressed-xml (`ewprj`, `multisim`)

PKWare DCL Implode (ASCII literal mode, large dictionary) wrapped in a
small container: a magic-string header, a 64-bit LE total decompressed
length, then a sequence of `(decompressed_length: u32,
compressed_length: u32, pkware_implode_block)` sections. Multisim chunks
big files into 900 000-decompressed-byte sections; `ewe` mirrors that.

Decode and encode are both supported. A decode/encode/decode round-trip
on every sample tested produces byte-identical XML, and the resulting
files are accepted by `ewd`.

### ewnet (`.ewnet`)

The netlist Multisim writes for Ultiboard forward annotation: UTF-16LE text
(with a BOM) holding S-expressions: `(ToolInfo ...)`, `(nets ...)` with
per-net routing rules, `(components (instance "<package>" "<refdes>" ...))`
with every pin's net, electrical type and label, and `(layers ...)`.

`ewd` parses it into a typed object (`parseEwnet`), keeping fields it doesn't
model in per-object `extra` maps plus the raw S-expression tree, so nothing
is lost. `ewnetConnectivity()` turns it into net → `{ refdes, pin }[]`.
Decode only; there is no encoder.

Two things to know when comparing against an `.ewprj`'s own net table:
Ultiboard upper-cases net names (`En` becomes `EN`), and an `.ewnet` is a
snapshot from the last forward annotation, so it goes stale if the board
was edited afterwards.

### mdb (`.prj`, `.usr`)

NI ships part libraries and project component databases as Microsoft
Access Jet 3 / Jet 4 files (despite the `.prj` / `.usr` extensions).
`ewd` reads them via [`mdb-reader`](https://www.npmjs.com/package/mdb-reader)
and emits a single JSON document with every table:

```json
{
  "format": "mdb",
  "source": "Stocked.prj",
  "tables": {
    "SYS_COMPONENT": {
      "columns": [{ "name": "Component_ID", "type": "long" }, ...],
      "rows": [{ "Component_ID": 17, "Component_Name": "BD9763FVM", ... }, ...]
    },
    ...
  }
}
```

Dates become ISO 8601 strings; binary blob fields (`ole` columns) become
`{ "_bytes": "base64", "value": "..." }` envelopes so the data survives a
JSON round-trip.

**Encode is a deliberately narrow byte-patch path, not a real Jet writer.**
Reimplementing Access's storage engine (page splits, B-tree index
maintenance, free-space tracking, `MSysObjects` invariants) is out of
scope for this project — `ewd`/`ewe` exist to move data **out** of
Electronics Workbench, not to clone Microsoft's database engine.

What `ewe` does on an `mdb` input today:

1. You decode with `ewd` to produce `<file>.prj.json`.
2. You edit the JSON in your text editor (or with a script).
3. You run `ewe edited.json`. It diffs the edited JSON against the
   original `.prj`, then for each changed cell where:
   - the column is `text` or `memo`,
   - the new value has the **same byte length** as the old,
   - the old value appears **exactly once** in the file,

   it overwrites the bytes in place. Anything that violates those
   constraints is skipped, and `--verbose` prints the reason per cell.

This is enough for the typical vendor / price / MPN editing workflow
because those values are usually unique and you usually substitute one
same-length identifier for another. It is **not** a general-purpose
editor and we don't intend to grow it into one.

### If you want general-purpose `.prj` edit support

Not planned in this repo. The clean way to add it is a separate,
optional, Windows-only tool that drives Microsoft's own Access engine:

- **ACE OLE DB Provider** (`Microsoft.ACE.OLEDB.12.0` / `16.0`) — free
  Redistributable from Microsoft, reads & writes both `.mdb` and `.accdb`.
- **Access ODBC driver** — same engine, ODBC interface. Pair with
  [`node-odbc`](https://github.com/markdirish/node-odbc) (N-API native
  addon) and issue plain SQL: `UPDATE SYS_USER_DATA SET USER_DEFINED_7 =
  ? WHERE Component_ID = ?`. The diff logic we already have for
  edited-JSON → changed-cells would generate those statements directly.
- **Jet OLE DB 4.0** — older, **32-bit only**, still works for Jet 3
  `.mdb` files like NI's `.prj`.

That path requires Windows + a driver install and so deliberately lives
outside this cross-platform repo's CI. The current byte-patch encode
covers the vendor/price editing case; for anything harder, route through
Access (or the ACE driver, or DAO/ADO) instead of expecting `ewe` to
grow into a full Jet writer.

## Format detection

`ewd` identifies the format by reading the magic bytes at the start of
the file, so the filename extension can be anything (renamed files, no
extension, `.dat`, etc.). It then dispatches to the right decoder.

`ewe` infers the format from the **output** filename's extension; pass
`--format <key>` to override for non-standard extensions. Out-of-range
Multisim versions (e.g. `.ms9` or future `.ms20+`) need an explicit
`--format multisim`.

## Install

### As a CLI (from npm)

```bash
npm i -g electronics-workbench-decoder   # puts `ewd` and `ewe` on your PATH
# …or run without installing:
npx -p electronics-workbench-decoder ewd MyDesign.ms14
```

The published package is a self-contained bundle that runs on Node ≥ 18 —
you don't need bun to use it. Installed this way, invoke the tools directly
as `ewd` / `ewe` (the `bun run ewd` form below is for working from source).

### For development (from source)

Requires [bun](https://bun.sh) (≥ 1.0).

```bash
bun install
```

## Decode

```bash
bun run ewd --verbose ./samples/Temp.ewprj ./samples/Design1.ms14
bun run ewd --verbose ./samples/Stocked.prj          # writes Stocked.prj.json
```

For each input, writes `<filename>.xml` (compressed-xml) or
`<filename>.json` (mdb, ewnet) next to it.

Options:

- `-v`, `--verbose` — log per-section progress
- `-c`, `--concurrent` — decode multiple files in parallel
- positional args — files to decode

## Encode

### Compressed-XML (greenfield encode from `.xml`)

```bash
bun run ewe --verbose ./samples/Temp.ewprj.xml
# or with explicit output:
bun run ewe --output ./out.ewprj ./samples/Temp.ewprj.xml
# or force a format on a non-standard extension:
bun run ewe --format multisim --output ./out.dat ./samples/Design1.ms14.xml
```

By default, strips a trailing `.xml` from each input to derive the output
path. Format is inferred from the output extension (see the table above).

### MDB in-place edits from `.json`

```bash
# Decode first to produce the editable JSON.
bun run ewd ./samples/Stocked.prj
# Edit ./samples/Stocked.prj.json in your editor / script.
# Then re-encode: ewe diffs vs the original and writes a patched copy.
bun run ewe --verbose ./samples/Stocked.prj.json
# -> samples/Stocked.prj.patched.prj
```

`ewe` recognizes `.json` inputs and routes them through the in-place
edit path. The original `.prj` location is taken from the JSON's
`source` field (or `--source <path>` to override). The patched copy
goes to `<source>.patched.prj` (or `--output <path>` to override).

Each `--verbose` run prints `N applied, M skipped` and lists every
skipped change with its reason. Skipped changes leave the file
untouched at that cell.

### Options

- `-v`, `--verbose` — log progress
- `-c`, `--concurrent` — encode multiple files in parallel
- `-o`, `--output <path>` — explicit output path (single-input only)
- `-s`, `--source <path>` — for MDB JSON inputs: override the source `.prj`
- `-f`, `--format <key>` — for compressed-XML: force a format (`ewprj` or `multisim`)
- positional args — XML or JSON files to encode

### Compression ratio caveat

`ewe` uses [`node-pkware`](https://github.com/cinderblock/node-pkware)'s
`implode` for compression. The repetition search isn't quite as
sophisticated as the original PKWare DCL implementation Multisim itself
uses — re-encoded files are roughly **2× the size** of the originals
(e.g. 9 KB `.ewprj` round-trips to 20 KB). The output is still valid
PKWare DCL Implode: round-trips are byte-identical on every sample
tested, and the resulting files are accepted by `ewd`.

This is a substantial improvement over the previous baseline (7-10×
bloat) thanks to fixes in the `v5-fix` branch of the
`cinderblock/node-pkware` fork — see `plans/jet-in-place-edit.md`
context and the fork's `v5-fix` branch for the specific bugs that
were patched.

## Programmatic API

The package also ships a library API (ESM + CJS, with TypeScript types) — the
same functions the CLIs are built on.

```ts
import {
  decodeFile,
  decodeBuffer,
  encodeBuffer,
  decodeMdbBuffer,
  parseEwnet,
  ewnetConnectivity,
  formatByKey,
} from 'electronics-workbench-decoder';

// Filename → decoded JS values (format detected from the file's magic bytes)
const result = await decodeFile('Design1.ms14');
if (result.kind === 'compressed-xml') {
  console.log(result.xml.toString()); // the decoded XML
} else if (result.kind === 'mdb') {
  console.log(result.data.tables.SYS_COMPONENT.rows); // Jet DB as a JS object
} else {
  console.log(result.netlist.components); // .ewnet netlist
}

// Buffer in, buffer out — no file I/O
const { xml } = decodeBuffer(ewprjBytes);
const ewprj = encodeBuffer(xml, formatByKey('ewprj')!);
const db = decodeMdbBuffer(prjBytes); // → { format, source, tables: {...} }
const netlist = parseEwnet(ewnetBytes); // → { toolInfo, nets, components, layers, tree }
const nets = ewnetConnectivity(netlist); // Map<net name, { refdes, pin }[]>
```

Exposed: `decodeFile`, `decodeBuffer`, `encodeBuffer`, `decodeMdbBuffer`,
`parseEwnet`, `ewnetConnectivity`, `ewnetText`, `parseSExpr`, the
format registry (`FORMATS`, `formatByKey`, `formatForExtension`,
`detectFormatByHeader`, `detectFileFormat`), and the supporting types
(`EwbFormat`, `MdbJson`, `DecodeResult`, `DecodedXml`, …).

Decoding covers every supported format. Encoding via the API covers the
compressed-xml containers (`encodeBuffer`); `.prj` in-place editing remains
CLI-only (`ewe`).

### Memory

Everything operates in memory — a file is read whole, decoded/encoded whole,
then written. Peak RAM is on the order of the input plus the decoded output.
This is fine for the file sizes Electronics Workbench produces (KB to a few
MB). Streaming wouldn't help the `.prj`/`.usr` databases anyway (Jet is a
random-access format that `mdb-reader` must load fully), and for the
compressed-xml containers it would only cap RAM at one ~900 KB section — a
marginal win not worth the added complexity at these sizes.

## Tests

```bash
bun test
```

Covers the format registry (extension matching, header detection
including the Jet magic prefix with leading NUL bytes, on-disk
detection), encoder filename helpers, `mdb` value normalization
(`Date` → ISO, OLE blobs → base64), the public library API (buffer
round-trips, `decodeFile` against a temp file), and compressed-xml
round-trip integration (tiny `.ewprj`, tiny `.ms14`, multi-block
payload that spans more than one PKWare section, and an empty payload).

## Development

```bash
bun run dev:ewd --verbose ./samples/Temp.ewprj
bun run dev:ewe --verbose ./samples/Temp.ewprj.xml
```

Both use `bun --watch` for fast reload on source changes.

## Lint, format, and typecheck

```bash
bun run check        # biome lint + format check (no changes)
bun run check:fix    # apply all safe fixes
bun run format       # format only
bun run typecheck    # tsc --noEmit
```

CI on push/PR runs `check`, `typecheck`, and `test` on Ubuntu and Windows.

## Releasing

Publishing to npm is automated by GitHub Actions
(`.github/workflows/publish.yml`) using npm Trusted Publishing (OIDC):
no stored `NPM_TOKEN`, and each release gets a signed provenance
attestation.

To cut a release:

```bash
npm version patch        # or `minor` / `major`; bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # pushing the tag triggers the publish workflow
```

The `vX.Y.Z` tag triggers the workflow, which verifies the tag matches
`package.json`, runs the full gate (`check` + `typecheck` + `test` +
license collection + `build`), then `npm publish --provenance`.

Notes for maintainers:

- The npm package has a **Trusted Publisher** configured for this repo and
  the `publish.yml` workflow. If you rename the workflow file or the repo,
  update that entry on npmjs.com to match — otherwise the OIDC identity
  won't match and publishing fails with a 404/permission error.
- The published artifact is a self-contained bundle. `dist/` and
  `THIRD-PARTY-LICENSES.md` are generated at publish time (by the
  `prepublishOnly` script) and are not committed.
- Runtime dependencies are bundled into `dist/`, so the published package
  declares none. `THIRD-PARTY-LICENSES.md` carries their license texts.

## See also

- [barncastle's `MultiSimConverter`](https://gist.github.com/barncastle/4277ac44aa47bf8c4389c7df0d160e56)
  — a separate, independent C# implementation that handles the same
  compressed-xml container. It round-trips the `.ms14` / `.ewprj` container
  to and from plain XML by
  P/Invoking the original PKWare `IMPLODE.DLL` (so its compression matches
  Multisim's exactly, avoiding the [ratio caveat](#compression-ratio-caveat)
  above). It dispatches on the same magic strings `ewd` reads
  (`MSMCompressedElectronicsWorkbenchXML`, `CompressedElectronicsWorkbenchXML`)
  and uses the same 900 000-byte block size. It covers only the compressed-xml
  container — not the Jet (`.prj` / `.usr`) part databases, and it doesn't
  convert designs to other EDA formats.
