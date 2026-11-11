/**
 * Known Electronics Workbench binary container formats. Each variant has a
 * fixed magic byte sequence at the start of the file so files can be identified
 * by content regardless of extension.
 *
 * There are currently two kinds of containers in scope:
 *
 *  - `compressed-xml`: PKWare-DCL-Implode-compressed XML, used for designs
 *    (`.ewprj`, `.ms1x`). Both decode and encode supported.
 *  - `mdb`: Microsoft Access Jet 3 databases, used for part libraries and
 *    project component databases (`.prj`, `.usr`). Decode supported; encode
 *    is deferred to in-place-edit-only and not yet implemented.
 *  - `ewnet`: UTF-16LE S-expression netlist Multisim writes for Ultiboard
 *    forward annotation (`.ewnet`). Decode (parse) only.
 */

import { promises as fs } from 'node:fs';

export type EwbFormatKind = 'compressed-xml' | 'mdb' | 'ewnet';

export interface EwbFormat {
  /** Short identifier for the `--format` CLI flag. */
  key: string;
  /** Human-readable name used in log output. */
  label: string;
  /** Magic bytes at the start of the file (latin1-encoded; any byte 0x00-0xff). */
  header: string;
  /** Extensions that default to this format when no `--format` is given. */
  extensionPattern: RegExp;
  /** Which decoder/encoder family handles this format. */
  kind: EwbFormatKind;
}

export const FORMATS: readonly EwbFormat[] = [
  {
    key: 'ewprj',
    label: 'Ultiboard / Electronics Workbench',
    header: 'CompressedElectronicsWorkbenchXML',
    extensionPattern: /\.ewprj$/i,
    kind: 'compressed-xml',
  },
  {
    key: 'multisim',
    label: 'Multisim',
    header: 'MSMCompressedElectronicsWorkbenchXML',
    // Multisim 10 through 19. Verified on .ms13 and .ms14; .ms10-12 / .ms15+
    // are extrapolated. Use `--format multisim` for files outside this range.
    extensionPattern: /\.ms1\d$/i,
    kind: 'compressed-xml',
  },
  {
    key: 'mdb',
    label: 'NI EW component database (Jet)',
    // Jet 3 / Jet 4 share this 19-byte prefix; the version byte at offset 0x14
    // distinguishes them but mdb-reader handles both.
    header: '\x00\x01\x00\x00Standard Jet DB',
    extensionPattern: /\.(prj|usr)$/i,
    kind: 'mdb',
  },
  {
    key: 'ewnet',
    label: 'Multisim -> Ultiboard netlist',
    // UTF-16LE BOM followed by "(ToolInfo" in UTF-16LE.
    header: '\xff\xfe(\x00T\x00o\x00o\x00l\x00I\x00n\x00f\x00o\x00',
    extensionPattern: /\.ewnet$/i,
    kind: 'ewnet',
  },
];

export const MAX_HEADER_LENGTH = Math.max(...FORMATS.map(f => f.header.length));

export function formatByKey(key: string): EwbFormat | undefined {
  return FORMATS.find(f => f.key === key);
}

export function formatForExtension(filename: string): EwbFormat | undefined {
  return FORMATS.find(f => f.extensionPattern.test(filename));
}

/**
 * Identify a file's format from its leading bytes. Tries longest header first
 * so a shorter header that happens to be a prefix of a longer one would never
 * swallow the longer match.
 */
export function detectFormatByHeader(buffer: Buffer): EwbFormat | undefined {
  return [...FORMATS]
    .sort((a, b) => b.header.length - a.header.length)
    .find(f => {
      const expected = Buffer.from(f.header, 'latin1');
      return buffer.length >= expected.length && buffer.subarray(0, expected.length).equals(expected);
    });
}

/** Read the leading bytes of a file and identify its format. */
export async function detectFileFormat(filename: string): Promise<EwbFormat | undefined> {
  const handle = await fs.open(filename, 'r');
  try {
    const buf = Buffer.allocUnsafe(MAX_HEADER_LENGTH);
    const { bytesRead } = await handle.read(buf, 0, MAX_HEADER_LENGTH, 0);
    return detectFormatByHeader(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function escapeForDisplay(s: string): string {
  return [...s]
    .map(c => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && code < 0x7f ? c : `\\x${code.toString(16).padStart(2, '0')}`;
    })
    .join('');
}

export function knownFormatsList(): string {
  return FORMATS.map(f => `${f.key} (${f.label}, header "${escapeForDisplay(f.header)}")`).join('; ');
}
