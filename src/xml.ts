/**
 * EW XML document model.
 *
 * The decompressed `.ms1x` / `.ewprj` payload is a plain XML document with a
 * narrow dialect: one `<?xml ...?>` declaration, elements and attributes only
 * (no text content, CDATA, comments or DTD in any known file), the five
 * predefined entities, and attribute values that may hold raw CR/LF and even
 * NUL bytes (RTF blobs, base64 with line breaks). Generic XML parsers either
 * reject the NULs or normalise the line breaks, so this one is purpose-built:
 *
 * - **Lossless.** Attribute order and raw values are kept; `toXml()` writes the
 *   document back in EW's own layout, byte-identical for files EW wrote.
 * - **Fast.** A single forward scan, no regex backtracking; large designs are
 *   tens of megabytes of XML.
 * - **Typed accessors** for the patterns EW uses everywhere: `Class`
 *   attributes, `&ASC`/`&UNI` strings, nanometre coordinates.
 */

/** One XML element. Text content is not part of the EW dialect and is rejected. */
export class EwElement {
  /** Element (tag) name. */
  readonly name: string;
  /** Attributes in document order, entity-decoded, otherwise raw. */
  readonly attrs: Record<string, string>;
  readonly children: EwElement[] = [];
  /** Parent element; undefined for the root. */
  parent: EwElement | undefined;

  constructor(name: string, attrs: Record<string, string> = {}, parent?: EwElement) {
    this.name = name;
    this.attrs = attrs;
    this.parent = parent;
  }

  /** The `Class` attribute (EW's C++ class name, e.g. `CIITLinkComp`), if any. */
  get cls(): string | undefined {
    return this.attrs.Class;
  }

  /** Raw attribute value. */
  get(attr: string): string | undefined {
    return this.attrs[attr];
  }

  has(attr: string): boolean {
    return Object.hasOwn(this.attrs, attr);
  }

  /** Attribute as an EW string (`&ASC` / `&UNI` decoded); `""` when absent. */
  str(attr: string): string {
    return decodeEwString(this.attrs[attr]);
  }

  /** Attribute as a number; `undefined` when absent, empty or not numeric. */
  num(attr: string): number | undefined {
    const v = this.attrs[attr];
    if (v == null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }

  /** Attribute as a number, with a fallback. */
  numOr(attr: string, fallback: number): number {
    return this.num(attr) ?? fallback;
  }

  /** Attribute as a 64-bit integer (layer masks and the like). */
  bigint(attr: string): bigint | undefined {
    const v = this.attrs[attr];
    if (v == null || !/^-?\d+$/.test(v.trim())) return undefined;
    return BigInt(v.trim());
  }

  /** EW booleans are `"1"`/`"0"` (occasionally `"true"`/`"false"`). */
  bool(attr: string): boolean | undefined {
    const v = this.attrs[attr];
    if (v == null) return undefined;
    return v === '1' || v.toLowerCase() === 'true';
  }

  /** First child element with this name. */
  child(name: string): EwElement | undefined {
    for (const c of this.children) if (c.name === name) return c;
    return undefined;
  }

  /** All child elements with this name (or all children). */
  childrenNamed(name?: string): EwElement[] {
    return name == null ? this.children : this.children.filter(c => c.name === name);
  }

  /** Follow a chain of child names: `el.at('Sheet', 'Variable', 'DesignSheet')`. */
  at(...path: string[]): EwElement | undefined {
    let cur: EwElement | undefined = this;
    for (const p of path) {
      cur = cur?.child(p);
      if (!cur) return undefined;
    }
    return cur;
  }

  /** Depth-first, document-order walk of all descendants (not including this). */
  *descendants(): Generator<EwElement> {
    const stack: EwElement[] = [];
    for (let i = this.children.length - 1; i >= 0; i--) stack.push(this.children[i] as EwElement);
    while (stack.length) {
      const e = stack.pop() as EwElement;
      yield e;
      for (let i = e.children.length - 1; i >= 0; i--) stack.push(e.children[i] as EwElement);
    }
  }

  /** First descendant matching a name or predicate. */
  find(match: string | ((e: EwElement) => boolean)): EwElement | undefined {
    const pred = typeof match === 'string' ? (e: EwElement) => e.name === match : match;
    for (const e of this.descendants()) if (pred(e)) return e;
    return undefined;
  }

  /** All descendants matching a name or predicate, in document order. */
  findAll(match: string | ((e: EwElement) => boolean)): EwElement[] {
    const pred = typeof match === 'string' ? (e: EwElement) => e.name === match : match;
    const out: EwElement[] = [];
    for (const e of this.descendants()) if (pred(e)) out.push(e);
    return out;
  }

  /** All descendants whose `Class` attribute equals one of `classes`. */
  findByClass(...classes: string[]): EwElement[] {
    const set = new Set(classes);
    return this.findAll(e => e.cls != null && set.has(e.cls));
  }

  /** Nearest ancestor matching a name or predicate. */
  closest(match: string | ((e: EwElement) => boolean)): EwElement | undefined {
    const pred = typeof match === 'string' ? (e: EwElement) => e.name === match : match;
    for (let p = this.parent; p; p = p.parent) if (pred(p)) return p;
    return undefined;
  }

  /** Serialise this element (and subtree) in EW's layout. */
  toXml(): string {
    const out: string[] = [];
    writeElement(this, out);
    return out.join('');
  }
}

/** A parsed EW XML document. */
export interface EwDocument {
  /** The `<?xml ...?>` declaration's attributes (`version`, `encoding`). */
  declaration: Record<string, string>;
  root: EwElement;
  /** `"multisim"` for `<MSMElectronicsWorkbench>`, `"ultiboard"` for `<ElectronicsWorkbench>`. */
  application: 'multisim' | 'ultiboard' | 'unknown';
}

export class EwXmlError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'EwXmlError';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(raw: string, offset: number): string {
  if (raw.indexOf('&') < 0) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, ent: string, at: number) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const v = ENTITIES[ent];
    if (v == null) throw new EwXmlError(`unknown entity ${whole}`, offset + at);
    return v;
  });
}

const encodeAttr = (v: string): string =>
  v.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );

function writeElement(e: EwElement, out: string[]): void {
  let open = `<${e.name}`;
  for (const k in e.attrs) open += ` ${k}="${encodeAttr(e.attrs[k] as string)}"`;
  if (e.children.length === 0) {
    out.push(`${open}/>\n`);
    return;
  }
  out.push(`${open}>\n`);
  for (const c of e.children) writeElement(c, out);
  out.push(`</${e.name}>\n`);
}

const isNameChar = (c: number) =>
  (c >= 97 && c <= 122) || // a-z
  (c >= 65 && c <= 90) || // A-Z
  (c >= 48 && c <= 57) || // 0-9
  c === 95 || // _
  c === 45 || // -
  c === 46 || // .
  c === 58; // :

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/** Parse EW XML text into a document tree. Accepts a string or UTF-8/ASCII bytes. */
export function parseEwXml(input: string | Uint8Array): EwDocument {
  const s = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  const len = s.length;
  let i = 0;
  let declaration: Record<string, string> = {};
  let root: EwElement | undefined;
  let cur: EwElement | undefined;

  const readName = (): string => {
    const start = i;
    while (i < len && isNameChar(s.charCodeAt(i))) i++;
    if (i === start) throw new EwXmlError('expected a name', i);
    return s.slice(start, i);
  };

  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      while (i < len && isSpace(s.charCodeAt(i))) i++;
      const c = s.charCodeAt(i);
      if (c === 62 /* > */ || c === 47 /* / */ || c === 63 /* ? */ || i >= len) return attrs;
      const name = readName();
      while (isSpace(s.charCodeAt(i))) i++;
      if (s.charCodeAt(i) !== 61 /* = */) throw new EwXmlError(`expected = after ${name}`, i);
      i++;
      while (isSpace(s.charCodeAt(i))) i++;
      const q = s.charCodeAt(i);
      if (q !== 34 && q !== 39) throw new EwXmlError(`expected quoted value for ${name}`, i);
      const end = s.indexOf(q === 34 ? '"' : "'", i + 1);
      if (end < 0) throw new EwXmlError(`unterminated value for ${name}`, i);
      attrs[name] = decodeEntities(s.slice(i + 1, end), i + 1);
      i = end + 1;
    }
  };

  while (i < len) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      if (s.slice(i).trim()) throw new EwXmlError('text content outside elements', i);
      break;
    }
    // EW never writes text content; anything but whitespace here is unexpected.
    for (let k = i; k < lt; k++) {
      if (!isSpace(s.charCodeAt(k))) throw new EwXmlError('unexpected text content', k);
    }
    i = lt + 1;
    const c = s.charCodeAt(i);
    if (c === 63 /* ? */) {
      i++;
      const target = readName();
      const attrs = readAttrs();
      if (s.slice(i, i + 2) !== '?>') throw new EwXmlError('unterminated processing instruction', i);
      i += 2;
      if (target === 'xml') declaration = attrs;
    } else if (c === 33 /* ! */) {
      // Comments / CDATA / DOCTYPE are not part of the dialect, but skip comments politely.
      if (s.startsWith('!--', i)) {
        const end = s.indexOf('-->', i);
        if (end < 0) throw new EwXmlError('unterminated comment', i);
        i = end + 3;
      } else throw new EwXmlError('unsupported markup declaration', i);
    } else if (c === 47 /* / */) {
      i++;
      const name = readName();
      while (isSpace(s.charCodeAt(i))) i++;
      if (s.charCodeAt(i) !== 62) throw new EwXmlError('expected >', i);
      i++;
      if (!cur || cur.name !== name) throw new EwXmlError(`mismatched </${name}>`, i);
      cur = cur.parent;
    } else {
      const name = readName();
      const attrs = readAttrs();
      const el = new EwElement(name, attrs, cur);
      if (cur) cur.children.push(el);
      else if (root) throw new EwXmlError('multiple root elements', lt);
      else root = el;
      if (s.charCodeAt(i) === 47) {
        if (s.charCodeAt(i + 1) !== 62) throw new EwXmlError('expected />', i);
        i += 2;
      } else if (s.charCodeAt(i) === 62) {
        i++;
        cur = el;
      } else throw new EwXmlError('unterminated start tag', i);
    }
  }
  if (cur) throw new EwXmlError(`unclosed <${cur.name}>`, len);
  if (!root) throw new EwXmlError('no root element', 0);
  const application =
    root.name === 'MSMElectronicsWorkbench'
      ? 'multisim'
      : root.name === 'ElectronicsWorkbench'
        ? 'ultiboard'
        : 'unknown';
  return { declaration, root, application };
}

/** Serialise a document back to EW XML text (EW's own layout). */
export function ewXmlText(doc: EwDocument): string {
  let head = '<?xml';
  for (const k in doc.declaration) head += ` ${k}="${encodeAttr(doc.declaration[k] as string)}"`;
  return `${head}?>\n${doc.root.toXml()}`;
}

/**
 * Decode an EW string attribute.
 *
 * - `&ASC<text>`: plain text after the prefix.
 * - `&UNI<text>`: text with `_uc<n><4 hex>×n` escapes for non-ASCII
 *   characters (`_uc100b5F` → `µF`, `_uc103a9` → `Ω`).
 * - Anything else is returned unchanged; absent values give `""`.
 */
export function decodeEwString(value: unknown): string {
  if (value == null) return '';
  const v = String(value);
  if (v.startsWith('&ASC')) return v.slice(4);
  if (v.startsWith('&UNI')) {
    return v.slice(4).replace(/_uc(\d)((?:[0-9a-fA-F]{4})+)/g, (_whole, count: string, hex: string) => {
      const n = Number(count);
      let out = '';
      for (let k = 0; k < n; k++) out += String.fromCharCode(Number.parseInt(hex.slice(k * 4, k * 4 + 4), 16));
      // Any hex digits past the counted ones are ordinary text.
      return out + hex.slice(n * 4);
    });
  }
  return v;
}

/** Encode text as an EW string: `&ASC` when plain ASCII, else `&UNI` with `_uc` escapes. */
export function encodeEwString(text: string): string {
  if (!/[\u0080-￿]/.test(text)) return `&ASC${text}`;
  // Escapes count UTF-16 code units, at most 9 per `_uc` run.
  return `&UNI${text.replace(/[\u0080-￿]+/g, run => {
    let out = '';
    for (let k = 0; k < run.length; k += 9) {
      const chunk = run.slice(k, k + 9);
      out += `_uc${chunk.length}`;
      for (let j = 0; j < chunk.length; j++) out += chunk.charCodeAt(j).toString(16).padStart(4, '0');
    }
    return out;
  })}`;
}

/** EW design coordinates are integer nanometres. */
export const NM_PER_MM = 1_000_000;
export const NM_PER_MIL = 25_400;
export const nmToMm = (nm: number): number => nm / NM_PER_MM;
export const nmToMil = (nm: number): number => nm / NM_PER_MIL;
export const mmToNm = (mm: number): number => Math.round(mm * NM_PER_MM);
export const milToNm = (mil: number): number => Math.round(mil * NM_PER_MIL);
