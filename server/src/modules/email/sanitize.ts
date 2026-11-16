import sanitizeHtml from 'sanitize-html';

// Safety for uploaded/edited templates and announcement content (Spec §9.1, §16).

/** Announcement rich text from the composer: a small, safe subset of HTML. */
export function sanitizeAnnouncement(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'blockquote', 'hr', 'code'],
    allowedAttributes: { a: ['href', 'title', 'rel'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  }).trim();
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/<\s*script\b/i, '<script> is not allowed'],
  [/<\s*iframe\b/i, '<iframe> is not allowed'],
  [/<\s*(form|input|button|select|textarea)\b/i, 'Forms are not allowed'],
  [/<\s*(object|embed|applet|frame|frameset)\b/i, 'Embedded objects are not allowed'],
  [/<\s*link\b/i, 'External stylesheets (<link>) are not allowed'],
  [/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, 'Meta refresh is not allowed'],
  [/@import\b/i, 'CSS @import is not allowed'],
  // Attributes can also follow "/" or a closing quote without whitespace: <img/onerror=…>, <a href="x"onclick=…>.
  [/(?:^|[\s/"'])on[a-z]{3,}\s*=/i, 'Event-handler attributes (onclick=…) are not allowed'],
  [/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*(?::|&colon;|&#0*58;?|&#x0*3a;?)/i, 'javascript: URLs are not allowed'],
  [/vbscript\s*:/i, 'vbscript: URLs are not allowed'],
  [/data\s*:\s*text\/html/i, 'data:text/html URLs are not allowed'],
  // Character references before the ":" of a URL scheme hide it from the checks above (java&#115;cript:).
  [/\b(?:href|src|action|background|formaction)\s*=\s*["']?[^"'>:]*&(?:#|tab;|newline;)[^"'>:]*(?::|&colon;)/i, 'Encoded characters in a link address are not allowed'],
  [/<\s*base\b/i, '<base> is not allowed'],
  [/url\(\s*["']?\s*(https?:)?\/\//i, 'Remote resources in CSS (url(http…)) are not allowed'],
];

/** Problems in an HTML/CSS template file. Templates are rejected, not silently changed. */
export function templateSafetyProblems(source: string): string[] {
  const problems = FORBIDDEN.filter(([re]) => re.test(source)).map(([, msg]) => msg);
  // Tracking pixels: remote images of 0–2 px.
  for (const m of source.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/src\s*=\s*["']?\s*(https?:)?\/\//i.test(tag) && /(width|height)\s*=\s*["']?\s*[0-2]\s*(px)?["'\s>]/i.test(tag)) problems.push('Tracking pixels (tiny remote images) are not allowed');
  }
  return [...new Set(problems)];
}

/** SVG assets: rejected when they contain scripts, event handlers or external references. */
export function svgProblems(svg: string): string[] {
  const p = templateSafetyProblems(svg);
  if (/<\s*foreignObject\b/i.test(svg)) p.push('SVG foreignObject is not allowed');
  if (/(xlink:)?href\s*=\s*["']\s*(https?:|\/\/|data:text)/i.test(svg)) p.push('SVG external references are not allowed');
  return p;
}
