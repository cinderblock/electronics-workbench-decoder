import { promises as fs } from 'node:fs';
import { decodeBuffer } from './decode';
import { decodeMdbBuffer, type MdbJson } from './decodeMdb';
import { type EwNetlist, parseEwnet } from './ewnet';
import { detectFormatByHeader, type EwbFormat, knownFormatsList, MAX_HEADER_LENGTH } from './formats';
import { UnexpectedValue } from './util/UnexpectedValue';

/**
 * The in-memory decoded representation of an EW file, discriminated by the
 * container kind:
 *
 * - `compressed-xml` (`.ewprj`, `.ms1x`): `xml` holds the decompressed XML
 *   bytes (call `.toString()` for text).
 * - `mdb` (`.prj`, `.usr`): `data` holds the database as a plain JS object
 *   (tables → `{ columns, rows }`).
 * - `ewnet` (`.ewnet`): `netlist` holds the parsed netlist.
 */
export type DecodeResult =
  | { kind: 'compressed-xml'; format: EwbFormat; xml: Buffer }
  | { kind: 'mdb'; format: EwbFormat; data: MdbJson }
  | { kind: 'ewnet'; format: EwbFormat; netlist: EwNetlist };

/**
 * Read an EW file from disk and decode it into in-memory JS values. The
 * container format is detected from the file's magic bytes, so the extension
 * doesn't matter.
 */
export async function decodeFile(filename: string): Promise<DecodeResult> {
  const buf = await fs.readFile(filename);
  const format = detectFormatByHeader(buf.subarray(0, MAX_HEADER_LENGTH));

  if (!format) {
    throw new UnexpectedValue(
      `"${filename}" doesn't match any known EW format. Supported: ${knownFormatsList()}`,
      `one of ${knownFormatsList()}`,
      buf.subarray(0, MAX_HEADER_LENGTH).toString('ascii'),
    );
  }

  switch (format.kind) {
    case 'compressed-xml':
      return { kind: 'compressed-xml', format, xml: decodeBuffer(buf).xml };
    case 'mdb':
      return { kind: 'mdb', format, data: decodeMdbBuffer(buf, filename) };
    case 'ewnet':
      return { kind: 'ewnet', format, netlist: parseEwnet(buf) };
  }
}
