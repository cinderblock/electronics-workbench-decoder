import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFileFormat,
  detectFormatByHeader,
  FORMATS,
  formatByKey,
  formatForExtension,
  knownFormatsList,
} from './formats';

const EWPRJ_HEADER = 'CompressedElectronicsWorkbenchXML';
const MULTISIM_HEADER = 'MSMCompressedElectronicsWorkbenchXML';
const JET_HEADER = '\x00\x01\x00\x00Standard Jet DB';

describe('FORMATS table', () => {
  test('every entry has a unique key', () => {
    const keys = FORMATS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every entry has a unique header', () => {
    const headers = FORMATS.map(f => f.header);
    expect(new Set(headers).size).toBe(headers.length);
  });

  test('every entry has a valid kind discriminator', () => {
    for (const f of FORMATS) {
      expect(['compressed-xml', 'mdb', 'ewnet']).toContain(f.kind);
    }
  });

  test('ewprj and multisim are compressed-xml; mdb is mdb', () => {
    expect(formatByKey('ewprj')?.kind).toBe('compressed-xml');
    expect(formatByKey('multisim')?.kind).toBe('compressed-xml');
    expect(formatByKey('mdb')?.kind).toBe('mdb');
  });
});

describe('formatByKey', () => {
  test('returns ewprj for "ewprj"', () => {
    expect(formatByKey('ewprj')?.header).toBe(EWPRJ_HEADER);
  });

  test('returns multisim for "multisim"', () => {
    expect(formatByKey('multisim')?.header).toBe(MULTISIM_HEADER);
  });

  test('returns undefined for unknown keys', () => {
    expect(formatByKey('nope')).toBeUndefined();
    expect(formatByKey('')).toBeUndefined();
  });
});

describe('formatForExtension', () => {
  test.each(['file.ewprj', 'a/b/c.ewprj'])('matches %s as ewprj', name => {
    expect(formatForExtension(name)?.key).toBe('ewprj');
  });

  test.each(['x.ms10', 'x.ms11', 'x.ms12', 'x.ms13', 'x.ms14', 'x.ms15', 'x.ms19'])('matches %s as multisim', name => {
    expect(formatForExtension(name)?.key).toBe('multisim');
  });

  test.each([
    'x.ms9',
    'x.ms20',
    'x.ms100',
    'x.txt',
    'x',
    'x.xml',
  ])('returns undefined for %s (outside known patterns)', name => {
    expect(formatForExtension(name)).toBeUndefined();
  });

  test.each(['db.prj', 'lib.usr', 'PATH/TO/Foo.PRJ', 'thing.USR'])('matches %s as mdb', name => {
    expect(formatForExtension(name)?.key).toBe('mdb');
  });
});

describe('detectFormatByHeader', () => {
  test('detects EWPRJ from its magic bytes', () => {
    const buf = Buffer.from(`${EWPRJ_HEADER}\x00\x00\x00\x00\x00\x00\x00\x00`, 'ascii');
    expect(detectFormatByHeader(buf)?.key).toBe('ewprj');
  });

  test('detects Multisim from its magic bytes', () => {
    const buf = Buffer.from(`${MULTISIM_HEADER}\x00\x00\x00\x00\x00\x00\x00\x00`, 'ascii');
    expect(detectFormatByHeader(buf)?.key).toBe('multisim');
  });

  test('detects EWPRJ even when the buffer carries extra trailing bytes (no false MSM match)', () => {
    // EWPRJ's header is a substring of MSM's header, but it appears at offset 3,
    // not at offset 0. So a buffer starting with the EWPRJ header but extending
    // longer must still resolve to EWPRJ, not MSM.
    const buf = Buffer.concat([Buffer.from(EWPRJ_HEADER, 'ascii'), Buffer.alloc(20)]);
    expect(detectFormatByHeader(buf)?.key).toBe('ewprj');
  });

  test('returns undefined for unrecognized headers', () => {
    expect(detectFormatByHeader(Buffer.from('NotAnEWFile1234567890', 'ascii'))).toBeUndefined();
    expect(detectFormatByHeader(Buffer.alloc(50))).toBeUndefined();
  });

  test('returns undefined when the buffer is too short to fit any header', () => {
    expect(detectFormatByHeader(Buffer.from('Compressed', 'ascii'))).toBeUndefined();
  });

  test('detects Jet/mdb from its magic bytes (including leading NUL bytes)', () => {
    const buf = Buffer.concat([Buffer.from(JET_HEADER, 'latin1'), Buffer.alloc(20)]);
    expect(detectFormatByHeader(buf)?.key).toBe('mdb');
  });

  test('detects Jet/mdb regardless of the version byte at offset 0x14', () => {
    // Jet 3 has 0x00 at offset 0x14, Jet 4 has 0x01. Both should match the
    // mdb format since our magic prefix stops before that byte.
    for (const verByte of [0x00, 0x01]) {
      const buf = Buffer.alloc(50);
      Buffer.from(JET_HEADER, 'latin1').copy(buf, 0);
      buf[0x14] = verByte;
      expect(detectFormatByHeader(buf)?.key).toBe('mdb');
    }
  });
});

describe('detectFileFormat', () => {
  test('reads bytes from disk and identifies a compressed-xml header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewd-detect-'));
    try {
      const path = join(dir, 'unknown.bin');
      await writeFile(path, Buffer.concat([Buffer.from(EWPRJ_HEADER, 'latin1'), Buffer.alloc(40)]));
      const format = await detectFileFormat(path);
      expect(format?.key).toBe('ewprj');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads bytes from disk and identifies a Jet header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewd-detect-'));
    try {
      const path = join(dir, 'looks-like-mdb.bin');
      await writeFile(path, Buffer.concat([Buffer.from(JET_HEADER, 'latin1'), Buffer.alloc(40)]));
      const format = await detectFileFormat(path);
      expect(format?.key).toBe('mdb');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns undefined for a file that matches nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewd-detect-'));
    try {
      const path = join(dir, 'random.bin');
      await writeFile(path, Buffer.from('This is not an EW file at all, just plain text.', 'utf8'));
      const format = await detectFileFormat(path);
      expect(format).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('knownFormatsList', () => {
  test('includes every format key', () => {
    const summary = knownFormatsList();
    for (const f of FORMATS) {
      expect(summary).toContain(f.key);
      expect(summary).toContain(f.label);
    }
  });
});
