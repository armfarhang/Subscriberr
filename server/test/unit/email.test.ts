import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_KINDS } from '@subscriberr/shared';
import { DEFAULT_BUILTIN_DIR, packJsonSchema, validatePack } from '../../src/modules/email/packs.js';
import { buildMime } from '../../src/modules/email/queue.js';
import { checkTemplate, renderEmail } from '../../src/modules/email/render.js';
import { sanitizeAnnouncement, svgProblems, templateSafetyProblems } from '../../src/modules/email/sanitize.js';

function builtin(id: string) {
  const dir = path.join(DEFAULT_BUILTIN_DIR, id);
  const files = new Map(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f))]));
  const meta = packJsonSchema.parse(JSON.parse(files.get('pack.json')!.toString('utf8')));
  const theme = Object.fromEntries(Object.entries(meta.theme).map(([k, v]) => [k, v.default]));
  return { files, subjects: meta.subjects, theme };
}

const vars = {
  member: { display_name: 'Ann & Co <3' },
  plan: { amount: '$15.00', period_days: 30 },
  paid_through: 'December 31, 2026',
  due_date: 'December 31, 2026',
  days_until_due: 3,
  grace_days: 3,
  amount_received: '$30.00',
  amount_expected: '$15.00',
  shortfall: '$5.00',
  credit: '',
  periods_covered: 2,
  etransfer_email: 'pay@example.com',
  etransfer_instructions: 'Use Autodeposit.',
  payment_memo_code: 'AN-1',
  app_name: 'Subscriberr',
  subject: 'Movie night',
  content: '<p>Hello <strong>all</strong></p>',
};

describe('template validation (Spec §9.1–§9.2)', () => {
  it('allows the documented variables, theme.* and if/unless blocks only', () => {
    expect(checkTemplate('{{member.display_name}} {{theme.accent_color}} {{#if credit}}{{credit}}{{else}}none{{/if}}{{#unless x}}{{/unless}}')).toEqual(['Unknown variable {{x}}']);
    expect(checkTemplate('{{member.email}}')).toEqual(['Unknown variable {{member.email}}']);
    expect(checkTemplate('{{#each items}}{{/each}}')).toEqual(expect.arrayContaining([expect.stringMatching(/Only \{\{#if\}\}/)]));
    expect(checkTemplate('{{> footer}}')).toEqual([expect.stringMatching(/Partials/)]);
    expect(checkTemplate('{{lookup this "x"}}')).toEqual([expect.stringMatching(/Helpers are not allowed/)]);
    expect(checkTemplate('{{#if}')).toEqual([expect.stringMatching(/syntax/)]);
  });

  it('rejects scripts, handlers, javascript: URLs, remote CSS and tracking pixels', () => {
    expect(templateSafetyProblems('<p onclick="x()">hi</p><script>1</script>')).toEqual(expect.arrayContaining(['<script> is not allowed', 'Event-handler attributes (onclick=…) are not allowed']));
    expect(templateSafetyProblems('<a href="javascript:alert(1)">x</a>')).toEqual(['javascript: URLs are not allowed']);
    expect(templateSafetyProblems('<style>@import url(https://x.example/a.css);</style>')).toEqual(expect.arrayContaining(['CSS @import is not allowed']));
    expect(templateSafetyProblems('<link rel="stylesheet" href="https://x">')).toEqual(['External stylesheets (<link>) are not allowed']);
    expect(templateSafetyProblems('<img src="https://t.example/p.gif" width="1" height="1">')).toEqual(['Tracking pixels (tiny remote images) are not allowed']);
    expect(templateSafetyProblems('<img src="assets/logo.png" width="120">')).toEqual([]);
    expect(svgProblems('<svg><script>x</script></svg>')).toContain('<script> is not allowed');
  });

  it('both built-in packs are valid and render every kind', () => {
    for (const id of ['default', 'minimal']) {
      const pack = builtin(id);
      expect(validatePack(pack.files), id).toEqual([]);
      for (const kind of TEMPLATE_KINDS) {
        const r = renderEmail(pack, kind, vars, pack.theme);
        expect(r.subject, `${id}/${kind}`).not.toBe('');
        expect(r.text, `${id}/${kind}`).not.toMatch(/<[a-z]/i);
      }
    }
  });

  it('a pack without its required files, or with a broken pack.json, is invalid', () => {
    const pack = builtin('default');
    const files = new Map(pack.files);
    files.delete('deficit.html');
    files.set('pack.json', Buffer.from('{"name": ""}'));
    files.set('layout.html', Buffer.from('<p>no slot</p>'));
    files.set('evil.exe', Buffer.from('x'));
    const problems = validatePack(files).map((p) => `${p.file}: ${p.message}`);
    expect(problems).toEqual(
      expect.arrayContaining(['deficit.html: Missing', 'layout.html: The layout needs a {{{content}}} slot', 'evil.exe: File type .exe is not allowed', expect.stringMatching(/^pack\.json: /)]),
    );
  });
});

describe('rendering', () => {
  it('escapes variables, inlines CSS, keeps the dark-mode rules and builds a text part', () => {
    const pack = builtin('default');
    const r = renderEmail(pack, 'thanks', vars, pack.theme);
    expect(r.subject).toBe("Thanks Ann & Co <3, you're paid through December 31, 2026");
    expect(r.html).toContain('Ann &amp; Co &lt;3');
    expect(r.html).toMatch(/<td class="band" style="[^"]*background: #14161f/);
    expect(r.html).toContain('prefers-color-scheme: dark');
    expect(r.html).toContain('2 × 30 days');
    expect(r.text).toContain('Thanks, Ann & Co <3!');
    expect(r.text).toContain('pay@example.com');
  });

  it('announcements put the composer text into the {{{content}}} slot', () => {
    const pack = builtin('default');
    const r = renderEmail(pack, 'announcement', vars, pack.theme);
    expect(r.subject).toBe('Movie night');
    expect(r.html).toContain('Hello <strong>all</strong>');
  });

  it('pack images become inline CID attachments; the MIME message is multipart', async () => {
    const pack = builtin('default');
    const files = new Map(pack.files);
    files.set('layout.html', Buffer.from(files.get('layout.html')!.toString('utf8').replace('<span class="dot"></span>', '<img src="assets/logo.png" width="24" alt="">')));
    files.set('assets/logo.png', Buffer.from('89504e47', 'hex'));
    const r = renderEmail({ ...pack, files }, 'thanks', vars, pack.theme);
    expect(r.html).toContain('src="cid:logopng@subscriberr"');
    expect(r.attachments).toMatchObject([{ filename: 'logo.png', cid: 'logopng@subscriberr', contentType: 'image/png' }]);
    const mime = (await buildMime({ fromName: 'Movie Club', fromAddress: 'owner@example.com', to: 'ann@example.com', subject: r.subject, html: JSON.stringify({ html: r.html, attachments: r.attachments.map((a) => ({ ...a, content: a.content.toString('base64') })) }), text: r.text })).toString();
    expect(mime).toMatch(/Content-Type: multipart\/(related|alternative)/);
    expect(mime).toContain('Content-ID: <logopng@subscriberr>');
    expect(mime).toMatch(/From: Movie Club <owner@example\.com>/);
    expect(mime).toContain('To: ann@example.com');
  });

  it('announcement HTML is sanitized', () => {
    expect(sanitizeAnnouncement('<p onclick="x()">Hi <a href="javascript:alert(1)">x</a> <a href="https://ok.example">ok</a></p><script>bad()</script><img src="https://t">')).toBe(
      '<p>Hi <a rel="noopener noreferrer">x</a> <a href="https://ok.example" rel="noopener noreferrer">ok</a></p>',
    );
  });
});
