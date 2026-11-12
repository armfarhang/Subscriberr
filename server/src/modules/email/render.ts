import Handlebars from 'handlebars';
import { convert as htmlToText } from 'html-to-text';
import juice from 'juice';
import { TEMPLATE_VARIABLES, type TemplateKind } from '@subscriberr/shared';

// Template rendering (Spec §9.1–§9.2): a kind partial rendered into the pack's layout, CSS
// inlined with juice, a plain-text part, inline images as CID attachments. Templates see only the
// fixed variable set; anything else fails validation when the pack is saved, never at send time.

export type TemplateVars = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], unknown>> & { member?: { display_name: string }; plan?: { amount: string; period_days: number } };

export interface PackFiles {
  /** Relative path → content. */
  files: Map<string, Buffer>;
  subjects: Record<TemplateKind, string>;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; cid: string; content: Buffer; contentType: string }>;
}

const ALLOWED_BLOCKS = new Set(['if', 'unless']);
const ALLOWED_PATHS = new Set<string>(TEMPLATE_VARIABLES);

/** Variable and helper check over the Handlebars AST. Returns problems (empty = fine). */
export function checkTemplate(source: string): string[] {
  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(source);
  } catch (err) {
    return [`Template syntax: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`];
  }
  const problems: string[] = [];
  const path = (p: hbs.AST.Expression) => (p.type === 'PathExpression' ? (p as hbs.AST.PathExpression).original : null);
  const checkPath = (name: string | null) => {
    if (!name) return;
    if (name === 'this' || name.startsWith('@')) return problems.push(`“${name}” is not allowed in templates`);
    if (!ALLOWED_PATHS.has(name) && !/^theme\.[a-z_][a-z0-9_]*$/.test(name)) problems.push(`Unknown variable {{${name}}}`);
  };
  const visit = (node: hbs.AST.Node) => {
    switch (node.type) {
      case 'Program':
        (node as hbs.AST.Program).body.forEach(visit);
        break;
      case 'MustacheStatement': {
        const m = node as hbs.AST.MustacheStatement;
        if (m.params.length > 0 || (m.hash && m.hash.pairs.length > 0)) problems.push(`Helpers are not allowed: {{${path(m.path) ?? '?'} …}}`);
        else checkPath(path(m.path));
        break;
      }
      case 'BlockStatement': {
        const b = node as hbs.AST.BlockStatement;
        const name = path(b.path);
        if (!name || !ALLOWED_BLOCKS.has(name)) problems.push(`Only {{#if}} and {{#unless}} blocks are allowed (found {{#${name ?? '?'}}})`);
        b.params.forEach((p) => checkPath(path(p)));
        if (b.program) visit(b.program);
        if (b.inverse) visit(b.inverse);
        break;
      }
      case 'PartialStatement':
      case 'PartialBlockStatement':
        problems.push('Partials ({{> …}}) are not allowed');
        break;
      case 'DecoratorBlock':
      case 'Decorator':
        problems.push('Decorators are not allowed');
        break;
      default:
        break;
    }
  };
  visit(ast);
  return [...new Set(problems)];
}

const hb = Handlebars.create();

function compile(source: string, opts: { noEscape?: boolean } = {}) {
  return hb.compile(source, { strict: false, noEscape: opts.noEscape ?? false, knownHelpersOnly: true, knownHelpers: { if: true, unless: true } });
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };

export function renderEmail(pack: PackFiles, kind: TemplateKind, vars: TemplateVars, theme: Record<string, string>): RenderedEmail {
  const file = (name: string) => {
    const b = pack.files.get(name);
    if (!b) throw new Error(`The template pack has no ${name}`);
    return b.toString('utf8');
  };
  const ctx = { ...vars, theme };
  const subject = compile(pack.subjects[kind] ?? '', { noEscape: true })(ctx).replace(/\s+/g, ' ').trim();
  const body = compile(file(`${kind}.html`))({ ...ctx, subject });
  let html = compile(file('layout.html'))({ ...ctx, subject, content: body });
  html = juice(html, { preserveMediaQueries: true, removeStyleTags: false, applyWidthAttributes: true });

  // Pack images (assets/…) become inline CID attachments.
  const attachments: RenderedEmail['attachments'] = [];
  html = html.replace(/(src=["'])assets\/([A-Za-z0-9._-]+)(["'])/g, (whole, a: string, name: string, b: string) => {
    const content = pack.files.get(`assets/${name}`);
    if (!content) return whole;
    const cid = `${name.replace(/[^A-Za-z0-9]/g, '')}@subscriberr`;
    if (!attachments.some((x) => x.cid === cid)) attachments.push({ filename: name, cid, content, contentType: MIME[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream' });
    return `${a}cid:${cid}${b}`;
  });

  const txt = pack.files.get(`${kind}.txt`);
  const text = txt
    ? compile(txt.toString('utf8'), { noEscape: true })({ ...ctx, subject, content: htmlToText(String(vars.content ?? ''), { wordwrap: 78 }) })
    : htmlToText(html, {
        wordwrap: 78,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'title', format: 'skip' },
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
          { selector: 'h1', options: { uppercase: false } },
          { selector: 'h2', options: { uppercase: false } },
          { selector: 'h3', options: { uppercase: false } },
          // Key-facts tables read as aligned "label   value" lines; layout tables stay plain blocks.
          { selector: 'table.facts', format: 'dataTable', options: { uppercaseHeaderCells: false, colSpacing: 3 } },
        ],
      });
  return { subject, html, text: text.trim(), attachments };
}
