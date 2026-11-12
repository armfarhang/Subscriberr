// Minimal XML reading for plex.tv's API responses (flat elements with attributes, one level of
// nesting). Not a general XML parser: it only extracts elements by tag name and their attributes.

export interface XmlElement {
  attrs: Record<string, string>;
  inner: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? _;
  });
}

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[3] ?? m[4] ?? '');
  return out;
}

/** Every <tag …/> or <tag …>…</tag> element (not nested in itself). */
export function xmlElements(xml: string, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[2] === '/') {
      out.push({ attrs: attributes(m[1]!), inner: '' });
      continue;
    }
    const close = xml.indexOf(`</${tag}>`, re.lastIndex);
    const end = close < 0 ? xml.length : close;
    out.push({ attrs: attributes(m[1]!), inner: xml.slice(re.lastIndex, end) });
    re.lastIndex = close < 0 ? xml.length : close + tag.length + 3;
  }
  return out;
}
