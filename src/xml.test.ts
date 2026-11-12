import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeBuffer,
  decodeEwString,
  EwXmlError,
  encodeEwString,
  ewXmlText,
  mmToNm,
  nmToMil,
  nmToMm,
  parseEwXml,
} from './index';

const SAMPLE = `<?xml version="1.0" encoding="ASCII"?>
<MSMElectronicsWorkbench Schema="67">
<Project Class="CProject" Name="&amp;ASCDesign1" Note="a &lt;b&gt; &quot;c&quot; &apos;d&apos;">
<Group>
<Item Class="CIITLinkComp" X="1000000" Y="-2540000" Mask="18446744073709551615" Visible="1"/>
<Item Class="CODPinComp" Label="&amp;UNI10_uc103a9 load_uc100b5F" Blob="line1\r\nline2\r\n\u0000"/>
</Group>
<Empty/>
</Project>
</MSMElectronicsWorkbench>
`;

describe('parseEwXml', () => {
  const doc = parseEwXml(SAMPLE);
  const project = doc.root.child('Project');

  test('declaration, root and application', () => {
    expect(doc.declaration).toEqual({ version: '1.0', encoding: 'ASCII' });
    expect(doc.root.name).toBe('MSMElectronicsWorkbench');
    expect(doc.application).toBe('multisim');
  });

  test('attributes are entity-decoded but otherwise raw', () => {
    expect(project?.get('Name')).toBe('&ASCDesign1');
    expect(project?.get('Note')).toBe('a <b> "c" \'d\'');
    const blob = project?.find(e => e.has('Blob'));
    expect(blob?.get('Blob')).toBe('line1\r\nline2\r\n\u0000');
  });

  test('typed accessors', () => {
    expect(project?.str('Name')).toBe('Design1');
    expect(project?.cls).toBe('CProject');
    const link = project?.findByClass('CIITLinkComp')[0];
    expect(link?.num('Y')).toBe(-2540000);
    expect(link?.num('Missing')).toBeUndefined();
    expect(link?.bigint('Mask')).toBe(18446744073709551615n);
    expect(link?.bool('Visible')).toBe(true);
    const pin = project?.findByClass('CODPinComp')[0];
    expect(pin?.str('Label')).toBe('10Ω loadµF');
  });

  test('navigation', () => {
    expect(doc.root.at('Project', 'Group')?.children.length).toBe(2);
    expect(doc.root.findAll('Item').map(e => e.cls)).toEqual(['CIITLinkComp', 'CODPinComp']);
    const item = doc.root.find('Item');
    expect(item?.closest('Project')).toBe(project);
    expect(item?.parent?.name).toBe('Group');
  });

  test('round-trips byte for byte', () => {
    expect(ewXmlText(doc)).toBe(SAMPLE);
  });

  test('rejects malformed input with an offset', () => {
    expect(() => parseEwXml('<a><b></a>')).toThrow(EwXmlError);
    expect(() => parseEwXml('<a>text</a>')).toThrow(/unexpected text/);
    expect(() => parseEwXml('<a x="&bogus;"/>')).toThrow(/unknown entity/);
    expect(() => parseEwXml('<a>')).toThrow(/unclosed/);
  });

  // samples/ holds private designs and is not committed; CI skips this.
  const samplesDir = join(import.meta.dir, '..', 'samples');
  test.skipIf(!existsSync(join(samplesDir, 'Design1.ms14')))('real designs round-trip', async () => {
    for (const name of ['Design1.ms14', 'Design1.ewprj']) {
      const buf = await readFile(join(samplesDir, name));
      const xml = decodeBuffer(buf).xml.toString('utf8');
      const d = parseEwXml(xml);
      expect(d.application).toBe(name.endsWith('.ms14') ? 'multisim' : 'ultiboard');
      expect(ewXmlText(d)).toBe(xml);
    }
  });
});

describe('EW strings', () => {
  test('decode', () => {
    expect(decodeEwString('&ASCR1')).toBe('R1');
    expect(decodeEwString('&UNI100 _uc100b5F')).toBe('100 µF');
    expect(decodeEwString('&UNI_uc203a903a9')).toBe('ΩΩ');
    // Hex digits beyond the counted characters are literal text.
    expect(decodeEwString('&UNI_uc103a9ABCD')).toBe('ΩABCD');
    expect(decodeEwString('plain')).toBe('plain');
    expect(decodeEwString(undefined)).toBe('');
  });

  test('encode round-trips', () => {
    for (const s of ['R1', '10µF', 'ΩΩ load', '']) expect(decodeEwString(encodeEwString(s))).toBe(s);
    expect(encodeEwString('R1')).toBe('&ASCR1');
    expect(encodeEwString('µ')).toBe('&UNI_uc100b5');
  });
});

test('unit helpers', () => {
  expect(nmToMm(2_540_000)).toBe(2.54);
  expect(nmToMil(2_540_000)).toBe(100);
  expect(mmToNm(0.254)).toBe(254_000);
});
