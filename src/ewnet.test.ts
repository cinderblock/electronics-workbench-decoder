import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFile, detectFormatByHeader, ewnetConnectivity, ewnetText, parseEwnet, parseSExpr } from './index';

// Synthetic netlist covering the shapes seen in real Multisim 14 output:
// rule-less nets, net groups, parens inside strings, unconnected pins,
// multi-section parts, and a layer table.
const SAMPLE = `(ToolInfo
\t(netlist "Ultiboard" 14 2 0)
\t(tool "Multisim" 14 2 0)
\t(timestamp "18-36-57"  "23-02-2021")
\t(version 4 0 0)
\t(gateswap 2)
\t(crossprobe {B2F33365-B1BC-4D9B-886B-3FF94038AA0C})
\t(units mil)
)
(nets
\t(net "VCC"
\t\t(trackwidth "8.00000000e+00")
\t\t(clearance_to_pad "6.00000000e+00")
\t\t(routing_layer "11")
\t\t(net_GUID "{1EAF8F6A-62D2-4C77-9D02-BA8790E3DDD9}")
\t)
\t(net "0"
\t\t(net_group "gnd")
\t\t(net_GUID "{2F4FD4C7-24B7-4738-932D-28287BF8A58A}")
\t)
\t(net "SC1/Switch"
\t\t(net_GUID "{A797FC25-C2BC-4EE5-9643-42B0B97C30A7}")
\t)
)
(components
\t(instance "TO-236AB-3(SOT23)" "Q1"
\t\t(device "BJT_NPN")
\t\t(value "MMBT3904")
\t\t(package_manufacturer "Generic")
\t\t(package_type "TO-236AB-3(SOT23)")
\t\t(rlc_component "0")
\t\t(placed_section ""
\t\t\t(section_guid "{BEDED7E8-5B81-49C8-90E9-FD22E781B28C}")
\t\t\t(pin "1" (net "VCC") (pintype "BIDIR") (label "B") (gateswapordinal "1"))
\t\t\t(pin "2" (net "0") (pintype "BIDIR") (label "E"))
\t\t\t(pin "3" (pintype "BIDIR") (label "C"))
\t\t)
\t)
\t(instance "DIP-8" "U1"
\t\t(device "OPAMP")
\t\t(value "LM358")
\t\t(placed_section "A"
\t\t\t(section_guid "{00000000-0000-0000-0000-000000000001}")
\t\t\t(pin "1" (net "VCC") (pintype "OUTPUT") (label "OUT") (section "A"))
\t\t)
\t\t(placed_section "B"
\t\t\t(section_guid "{00000000-0000-0000-0000-000000000000}")
\t\t\t(unplaced_schematic_section "1")
\t\t)
\t)
)
(layers
\t(layer "Top"
\t\t(layer_description "Copper Top")
\t\t(layer_type "Signal")
\t\t(routable "1")
\t\t(stackup_type "Inner")
\t)
)
`;

const utf16 = (s: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\n/g, '\r\n'), 'utf16le')]);

describe('parseSExpr', () => {
  test('keeps parentheses inside quoted strings', () => {
    expect(parseSExpr('(a "x(y)z" b)')).toEqual([['a', 'x(y)z', 'b']]);
  });
  test('rejects unbalanced input', () => {
    expect(() => parseSExpr('(a (b)')).toThrow();
    expect(() => parseSExpr('(a))')).toThrow();
    expect(() => parseSExpr('(a "b)')).toThrow();
  });
});

describe('parseEwnet', () => {
  const n = parseEwnet(utf16(SAMPLE));

  test('reads ToolInfo', () => {
    expect(n.toolInfo.netlist).toEqual({ name: 'Ultiboard', version: [14, 2, 0] });
    expect(n.toolInfo.tool).toEqual({ name: 'Multisim', version: [14, 2, 0] });
    expect(n.toolInfo.units).toBe('mil');
    expect(n.toolInfo.timestamp).toEqual(['18-36-57', '23-02-2021']);
    expect(n.toolInfo.crossprobe).toBe('{B2F33365-B1BC-4D9B-886B-3FF94038AA0C}');
    expect(n.toolInfo.extra.gateswap).toEqual(['2']);
  });

  test('reads nets with numeric rules, groups and GUIDs', () => {
    expect(n.nets.map(x => x.name)).toEqual(['VCC', '0', 'SC1/Switch']);
    expect(n.nets[0]?.rules).toEqual({ trackwidth: 8, clearance_to_pad: 6, routing_layer: 11 });
    expect(n.nets[1]?.group).toBe('gnd');
    expect(n.nets[2]?.guid).toBe('{A797FC25-C2BC-4EE5-9643-42B0B97C30A7}');
  });

  test('reads components, sections and pins', () => {
    const q1 = n.components[0];
    expect(q1?.refdes).toBe('Q1');
    expect(q1?.package).toBe('TO-236AB-3(SOT23)');
    expect(q1?.value).toBe('MMBT3904');
    expect(q1?.extra.rlc_component).toEqual(['0']);
    expect(q1?.sections[0]?.pins.map(p => [p.number, p.net, p.label])).toEqual([
      ['1', 'VCC', 'B'],
      ['2', '0', 'E'],
      ['3', undefined, 'C'],
    ]);
    const u1 = n.components[1];
    expect(u1?.sections.map(s => [s.name, s.unplaced, s.pins.length])).toEqual([
      ['A', false, 1],
      ['B', true, 0],
    ]);
    expect(u1?.sections[0]?.pins[0]?.section).toBe('A');
  });

  test('reads layers', () => {
    expect(n.layers).toEqual([
      { name: 'Top', description: 'Copper Top', type: 'Signal', stackupType: 'Inner', routable: true, extra: {} },
    ]);
  });

  test('keeps the raw tree', () => {
    expect(n.tree.length).toBe(4);
  });

  test('connectivity maps nets to pins, skipping unconnected pins', () => {
    const c = ewnetConnectivity(n);
    expect(c.get('VCC')).toEqual([
      { refdes: 'Q1', pin: '1' },
      { refdes: 'U1', pin: '1' },
    ]);
    expect(c.get('0')).toEqual([{ refdes: 'Q1', pin: '2' }]);
    expect(c.get('SC1/Switch')).toEqual([]);
  });

  test('accepts text and UTF-8 bytes too', () => {
    expect(parseEwnet(SAMPLE).nets.length).toBe(3);
    expect(parseEwnet(Buffer.from(SAMPLE, 'utf8')).nets.length).toBe(3);
  });

  test('decodes UTF-16BE with BOM', () => {
    const be = Buffer.from(SAMPLE, 'utf16le');
    be.swap16();
    expect(ewnetText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(SAMPLE);
  });
});

describe('format detection + decodeFile', () => {
  test('detects .ewnet by header', () => {
    expect(detectFormatByHeader(utf16(SAMPLE))?.key).toBe('ewnet');
  });

  test('decodeFile returns a parsed netlist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewnet-'));
    try {
      const file = join(dir, 'renamed.dat');
      await writeFile(file, utf16(SAMPLE));
      const r = await decodeFile(file);
      expect(r.kind).toBe('ewnet');
      if (r.kind === 'ewnet') expect(r.netlist.components.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
