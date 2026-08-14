/**
 * Tiny XML field extractors for Braintree responses/webhooks.
 *
 * Braintree's XML is well-formed and predictable, so we extract the handful of
 * fields we need with targeted matching rather than pulling in an XML parser. Not
 * a general-purpose XML library — just enough for gateway responses and webhook
 * notifications.
 */

/** Raw inner content of the first `<name ...>…</name>` element (attributes allowed). */
export function xmlInner(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : undefined;
}

/** All inner contents of `<name>…</name>` elements (for array-typed sections). */
export function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
  return out;
}

/** Decode the five predefined XML entities and trim. */
export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Decoded text of a leaf element, or undefined if absent. */
export function xmlLeaf(xml: string, name: string): string | undefined {
  const inner = xmlInner(xml, name);
  return inner === undefined ? undefined : decodeXml(inner);
}
