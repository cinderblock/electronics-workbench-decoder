/**
 * Read Multisim → Ultiboard forward-annotation netlists (`.ewnet`).
 *
 * The file is UTF-16LE text (with a BOM) holding a handful of top-level
 * S-expressions:
 *
 *     (ToolInfo (netlist "Ultiboard" 14 2 0) (tool "Multisim" 14 2 0) (units mil) ...)
 *     (nets (net "VCC" (trackwidth "8.0e+00") ... (net_GUID "{...}")) ...)
 *     (components
 *       (instance "<package>" "<refdes>"
 *         (device "...") (value "...") (package_type "...") ...
 *         (placed_section "<section name or empty>"
 *           (section_guid "{...}")
 *           (pin "1" (net "VCC") (pintype "BIDIR") (label "P1") (gateswapordinal "1")))))
 *     (layers (layer "Top" (layer_type "Signal") ...) ...)
 *
 * Quoted strings never contain escapes in any sample seen, but may contain
 * parentheses (`"TO-236AB-3(SOT23)"`). Bare tokens are numbers or GUIDs.
 *
 * `parseEwnet` returns a typed view of the well-understood parts plus the raw
 * S-expression tree, so nothing in the file is lost. Fields not modelled
 * explicitly are kept in each object's `extra` map (key → values).
 */

import { promises as fs } from 'node:fs';
import { asBuffer } from './util/buffer';
import type { Logger } from './util/logger';

/** One S-expression node: an atom (string) or a list. */
export type SExpr = string | SExpr[];

export interface EwnetToolInfo {
  /** e.g. `{ name: "Ultiboard", version: [14, 2, 0] }` */
  netlist?: { name: string; version: number[] };
  tool?: { name: string; version: number[] };
  /** Raw timestamp fields as written (`["18-36-57", "23-02-2021"]`). */
  timestamp?: string[];
  version?: number[];
  /** Unit for the numeric rule values in `nets` (`"mil"` in every sample). */
  units?: string;
  crossprobe?: string;
  extra: Record<string, string[]>;
}

export interface EwnetNet {
  name: string;
  guid?: string;
  /** e.g. `"gnd"` for the ground net. */
  group?: string;
  /**
   * Routing rules, numeric where the value parses as a number:
   * `trackwidth`, `trackwidth_min`, `trackwidth_max`, `clearance_to_trace`,
   * `clearance_to_pad`, `clearance_to_via`, `clearance_to_copper` (in
   * `toolInfo.units`), `routing_layer`, ...
   */
  rules: Record<string, number | string>;
}

export interface EwnetPin {
  /** Pin number as used on the footprint, e.g. `"1"`. */
  number: string;
  /** Net name; absent for unconnected pins. */
  net?: string;
  /** Electrical type, e.g. `"BIDIR"`, `"INPUT"`, `"POWER"`. */
  pintype?: string;
  /** Pin name on the schematic symbol, e.g. `"GPIO4"`. */
  label?: string;
  /** Section (gate) the pin belongs to, for multi-section parts. */
  section?: string;
  extra: Record<string, string[]>;
}

export interface EwnetSection {
  /** Section name; `""` for single-section parts. */
  name: string;
  guid?: string;
  /** True when the section is listed but not placed on the schematic. */
  unplaced: boolean;
  pins: EwnetPin[];
  extra: Record<string, string[]>;
}

export interface EwnetComponent {
  refdes: string;
  /** First field of `(instance ...)`: the footprint / package name. */
  package: string;
  device?: string;
  value?: string;
  packageManufacturer?: string;
  packageType?: string;
  sections: EwnetSection[];
  extra: Record<string, string[]>;
}

export interface EwnetLayer {
  name: string;
  description?: string;
  type?: string;
  stackupType?: string;
  routable?: boolean;
  extra: Record<string, string[]>;
}

export interface EwNetlist {
  format: 'ewnet';
  toolInfo: EwnetToolInfo;
  nets: EwnetNet[];
  components: EwnetComponent[];
  layers: EwnetLayer[];
  /** Every top-level S-expression, verbatim. */
  tree: SExpr[];
}

/** Tokenize + parse S-expression text into top-level nodes. */
export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '(') {
      const list: SExpr[] = [];
      (stack[stack.length - 1] as SExpr[]).push(list);
      stack.push(list);
      i++;
    } else if (c === ')') {
      if (stack.length === 1) throw new Error(`ewnet: unbalanced ")" at offset ${i}`);
      stack.pop();
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new Error(`ewnet: unterminated string at offset ${i}`);
      (stack[stack.length - 1] as SExpr[]).push(text.slice(i + 1, end));
      i = end + 1;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') {
      i++;
    } else {
      let j = i;
      while (j < n && !' \t\r\n()"'.includes(text[j] as string)) j++;
      (stack[stack.length - 1] as SExpr[]).push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error(`ewnet: ${stack.length - 1} unclosed "(" at end of input`);
  return root;
}

const isList = (x: SExpr | undefined): x is SExpr[] => Array.isArray(x);
const head = (x: SExpr): string | undefined => (isList(x) && typeof x[0] === 'string' ? x[0] : undefined);
const atoms = (x: SExpr[]): string[] => x.slice(1).filter((a): a is string => typeof a === 'string');
const children = (x: SExpr[]): SExpr[][] => x.filter(isList);

/**
 * Split a list's child lists into the known keys (first atom value each) and
 * the rest (all atom values, keyed by head) for `extra`.
 */
function fields(list: SExpr[], known: readonly string[], skip: readonly string[] = []) {
  const got: Record<string, string> = {};
  const extra: Record<string, string[]> = {};
  for (const c of children(list)) {
    const k = head(c);
    if (k === undefined || skip.includes(k)) continue;
    if (known.includes(k)) got[k] = atoms(c)[0] ?? '';
    else extra[k] = atoms(c);
  }
  return { got, extra };
}

const num = (s: string): number | string => {
  const v = Number(s);
  return s.trim() !== '' && Number.isFinite(v) ? v : s;
};

function parseToolInfo(list: SExpr[]): EwnetToolInfo {
  const out: EwnetToolInfo = { extra: {} };
  for (const c of children(list)) {
    const k = head(c);
    const a = atoms(c);
    switch (k) {
      case 'netlist':
      case 'tool':
        out[k] = { name: a[0] ?? '', version: a.slice(1).map(Number) };
        break;
      case 'timestamp':
        out.timestamp = a;
        break;
      case 'version':
        out.version = a.map(Number);
        break;
      case 'units':
        out.units = a[0];
        break;
      case 'crossprobe':
        out.crossprobe = a[0];
        break;
      default:
        if (k !== undefined) out.extra[k] = a;
    }
  }
  return out;
}

function parseNet(list: SExpr[]): EwnetNet {
  const net: EwnetNet = { name: atoms(list)[0] ?? '', rules: {} };
  for (const c of children(list)) {
    const k = head(c);
    const v = atoms(c)[0] ?? '';
    if (k === 'net_GUID') net.guid = v;
    else if (k === 'net_group') net.group = v;
    else if (k !== undefined) net.rules[k] = num(v);
  }
  return net;
}

function parsePin(list: SExpr[]): EwnetPin {
  const { got, extra } = fields(list, ['net', 'pintype', 'label', 'section']);
  return {
    number: atoms(list)[0] ?? '',
    net: got.net,
    pintype: got.pintype,
    label: got.label,
    section: got.section,
    extra,
  };
}

function parseSection(list: SExpr[]): EwnetSection {
  const { got, extra } = fields(list, ['section_guid', 'unplaced_schematic_section'], ['pin']);
  return {
    name: atoms(list)[0] ?? '',
    guid: got.section_guid,
    unplaced: got.unplaced_schematic_section === '1',
    pins: children(list)
      .filter(c => head(c) === 'pin')
      .map(parsePin),
    extra,
  };
}

function parseInstance(list: SExpr[]): EwnetComponent {
  const [pkg, refdes] = atoms(list);
  const { got, extra } = fields(list, ['device', 'value', 'package_manufacturer', 'package_type'], ['placed_section']);
  return {
    refdes: refdes ?? '',
    package: pkg ?? '',
    device: got.device,
    value: got.value,
    packageManufacturer: got.package_manufacturer,
    packageType: got.package_type,
    sections: children(list)
      .filter(c => head(c) === 'placed_section')
      .map(parseSection),
    extra,
  };
}

function parseLayer(list: SExpr[]): EwnetLayer {
  const { got, extra } = fields(list, ['layer_description', 'layer_type', 'stackup_type', 'routable']);
  return {
    name: atoms(list)[0] ?? '',
    description: got.layer_description,
    type: got.layer_type,
    stackupType: got.stackup_type,
    routable: got.routable === undefined ? undefined : got.routable === '1',
    extra,
  };
}

/** Decode `.ewnet` bytes to text: UTF-16LE with BOM, UTF-16BE with BOM, else UTF-8. */
export function ewnetText(input: Uint8Array): string {
  const buf = asBuffer(input);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** Parse a `.ewnet` netlist from its raw bytes or already-decoded text. */
export function parseEwnet(input: Uint8Array | string): EwNetlist {
  const text = typeof input === 'string' ? input : ewnetText(input);
  const tree = parseSExpr(text);
  const out: EwNetlist = {
    format: 'ewnet',
    toolInfo: { extra: {} },
    nets: [],
    components: [],
    layers: [],
    tree,
  };
  for (const top of tree) {
    if (!isList(top)) continue;
    switch (head(top)) {
      case 'ToolInfo':
        out.toolInfo = parseToolInfo(top);
        break;
      case 'nets':
        out.nets.push(
          ...children(top)
            .filter(c => head(c) === 'net')
            .map(parseNet),
        );
        break;
      case 'components':
        out.components.push(
          ...children(top)
            .filter(c => head(c) === 'instance')
            .map(parseInstance),
        );
        break;
      case 'layers':
        out.layers.push(
          ...children(top)
            .filter(c => head(c) === 'layer')
            .map(parseLayer),
        );
        break;
    }
  }
  return out;
}

/** A pin on a component, as referenced from a net. */
export interface EwnetPinRef {
  refdes: string;
  pin: string;
}

/**
 * Net name → the component pins on it. Every net in `nets` gets an entry
 * (possibly empty); nets that only appear on pins are added too.
 */
export function ewnetConnectivity(netlist: EwNetlist): Map<string, EwnetPinRef[]> {
  const map = new Map<string, EwnetPinRef[]>(netlist.nets.map(n => [n.name, []]));
  for (const comp of netlist.components) {
    for (const section of comp.sections) {
      for (const pin of section.pins) {
        if (pin.net === undefined) continue;
        let list = map.get(pin.net);
        if (!list) {
          list = [];
          map.set(pin.net, list);
        }
        list.push({ refdes: comp.refdes, pin: pin.number });
      }
    }
  }
  return map;
}

/**
 * CLI helper: parse `<filename>` and write the netlist as JSON to
 * `<filename>.json` (without the raw `tree`, which duplicates the typed view).
 */
export async function decodeEwnetFile(filename: string, logger: Logger, outFile = `${filename}.json`): Promise<void> {
  logger.verbose(`Reading ${filename}`);
  const { tree: _tree, ...netlist } = parseEwnet(await fs.readFile(filename));
  logger.silly(`Parsed ${netlist.nets.length} nets, ${netlist.components.length} components`);
  await fs.writeFile(outFile, JSON.stringify(netlist, null, 2));
  logger.verbose(`Wrote ${outFile}`);
}
