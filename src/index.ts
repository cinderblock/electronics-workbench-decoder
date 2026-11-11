/**
 * Programmatic API for the Electronics Workbench decoder/encoder.
 *
 * Three layers:
 *
 * - **Filename → JS values**: `decodeFile(path)` reads a file and returns the
 *   decoded data in memory (XML bytes for compressed-xml, a `MdbJson` object
 *   for Jet databases), discriminated by `kind`.
 * - **Buffer cores** (pure, no I/O): `decodeBuffer` / `encodeBuffer` for the
 *   compressed-xml containers, `decodeMdbBuffer` for Jet databases.
 * - **Format registry**: detect/identify the container formats.
 *
 * The CLIs (`ewd`, `ewe`) are built on these same functions.
 */

// Compressed-XML codec (.ewprj, .ms1x)
export { type DecodedXml, decodeBuffer } from './decode';
// Filename → decoded JS values
export { type DecodeResult, decodeFile } from './decodeFile';
// Jet / Access component databases (.prj, .usr)
export { type ColumnInfo, decodeMdbBuffer, type MdbJson, type TableJson } from './decodeMdb';
export { DEFAULT_BLOCK_SIZE, encodeBuffer } from './encode';
// Multisim -> Ultiboard netlists (.ewnet)
export {
  type EwNetlist,
  type EwnetComponent,
  type EwnetLayer,
  type EwnetNet,
  type EwnetPin,
  type EwnetPinRef,
  type EwnetSection,
  type EwnetToolInfo,
  ewnetConnectivity,
  ewnetText,
  parseEwnet,
  parseSExpr,
  type SExpr,
} from './ewnet';
// Format registry
export {
  detectFileFormat,
  detectFormatByHeader,
  type EwbFormat,
  type EwbFormatKind,
  FORMATS,
  formatByKey,
  formatForExtension,
  knownFormatsList,
  MAX_HEADER_LENGTH,
} from './formats';
