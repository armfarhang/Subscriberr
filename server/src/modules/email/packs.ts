import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { type PackDetail, type PackProblem, type PackSummary, TEMPLATE_FILE_TYPES, TEMPLATE_KINDS, TEMPLATE_LIMITS, type TemplateKind, type ThemeVariable } from '@subscriberr/shared';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound } from '../../core/errors.js';
import { extractZipSafely, isSafeEntryName, UnsafeZipError } from '../../core/safe-zip.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { resolveInWorkspace } from '../workspaces/files.js';
import { readJsonSetting, writeJsonSetting } from '../workspaces/settings.js';
import { checkTemplate, type PackFiles } from './render.js';
import { svgProblems, templateSafetyProblems } from './sanitize.js';

// Template packs are FILES (Spec §9.1, D12): built-ins ship in the image (read-only), custom packs
// live at /data/workspaces/{account}/templates/<pack-id>/. The database only stores which pack is
// active and the theme values.

/** templates/builtin at the repository root (works from src/ and dist/). */
export const DEFAULT_BUILTIN_DIR = fileURLToPath(new URL('../../../../templates/builtin', import.meta.url));
export const DEFAULT_PACK_ID = 'default';

export interface PackEnv {
  builtinDir: string;
  workspacesDir: string;
}

const ACTIVE_KEY = 'template_pack';
const themeKey = (packId: string) => `template_theme:${packId}`;

const themeVarSchema = z.object({ label: z.string().max(60), type: z.enum(['color', 'number', 'text']), default: z.string().max(400) });
export const packJsonSchema = z.object({
  name: z.string().trim().min(1).max(60),
  version: z.string().max(20).default('1.0.0'),
  author: z.string().max(100).default(''),
  description: z.string().max(500).default(''),
  subjects: z.object(Object.fromEntries(TEMPLATE_KINDS.map((k) => [k, z.string().min(1).max(200)])) as Record<TemplateKind, z.ZodString>),
  theme: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/).max(64), themeVarSchema).default({}),
  sample: z.record(z.string(), z.unknown()).default({}),
});
export type PackJson = z.infer<typeof packJsonSchema>;

export interface LoadedPack extends PackFiles {
  id: string;
  builtin: boolean;
  meta: PackJson;
}

const customRoot = (env: PackEnv, ws: WorkspaceContext) => resolveInWorkspace(env.workspacesDir, ws.accountId, 'templates');

function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, relPath);
      if (statSync(full).isDirectory()) walk(relPath);
      else files.set(relPath, readFileSync(full));
    }
  };
  walk('');
  return files;
}

function builtinIds(env: PackEnv): string[] {
  return existsSync(env.builtinDir) ? readdirSync(env.builtinDir).filter((d) => existsSync(path.join(env.builtinDir, d, 'pack.json'))).sort((a, b) => (a === DEFAULT_PACK_ID ? -1 : b === DEFAULT_PACK_ID ? 1 : a.localeCompare(b))) : [];
}

function customIds(env: PackEnv, ws: WorkspaceContext): string[] {
  const root = customRoot(env, ws);
  return existsSync(root) ? readdirSync(root).filter((d) => !d.startsWith('.') && existsSync(path.join(root, d, 'pack.json'))).sort() : [];
}

function packDir(env: PackEnv, ws: WorkspaceContext, id: string): { dir: string; builtin: boolean } | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return null;
  if (builtinIds(env).includes(id)) return { dir: path.join(env.builtinDir, id), builtin: true };
  const dir = path.join(customRoot(env, ws), id);
  return existsSync(path.join(dir, 'pack.json')) ? { dir, builtin: false } : null;
}

function toLoaded(id: string, builtin: boolean, files: Map<string, Buffer>): LoadedPack {
  const meta = packJsonSchema.parse(JSON.parse(files.get('pack.json')!.toString('utf8')));
  return { id, builtin, meta, files, subjects: meta.subjects };
}

export function loadPack(env: PackEnv, ws: WorkspaceContext, id: string): LoadedPack {
  const where = packDir(env, ws, id);
  if (!where) throw notFound('Template pack not found');
  return toLoaded(id, where.builtin, readTree(where.dir));
}

export function activePackId(env: PackEnv, ws: WorkspaceContext): string {
  const id = readJsonSetting(ws, ACTIVE_KEY);
  return typeof id === 'string' && packDir(env, ws, id) ? id : DEFAULT_PACK_ID;
}

export function loadActivePack(env: PackEnv, ws: WorkspaceContext): LoadedPack {
  return loadPack(env, ws, activePackId(env, ws));
}

export function setActivePack(env: PackEnv, ws: WorkspaceContext, id: string): void {
  loadPack(env, ws, id);
  writeJsonSetting(ws, ACTIVE_KEY, id);
}

/** Saved theme values merged over the pack's defaults. */
export function themeValues(ws: WorkspaceContext, pack: LoadedPack): Record<string, string> {
  const saved = (readJsonSetting(ws, themeKey(pack.id)) ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(pack.meta.theme).map(([k, v]) => [k, typeof saved[k] === 'string' ? saved[k] : v.default]));
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/;
export function saveThemeValues(env: PackEnv, ws: WorkspaceContext, id: string, values: Record<string, string>): void {
  const pack = loadPack(env, ws, id);
  const problems: string[] = [];
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const def = pack.meta.theme[k];
    if (!def) continue;
    if (def.type === 'color' && !COLOR.test(v)) problems.push(`${def.label}: use a colour like #6d5efc`);
    else if (def.type === 'number' && !/^\d{1,3}$/.test(v)) problems.push(`${def.label}: use a whole number`);
    // Theme values may be output unescaped in CSS (e.g. a font stack with quotes), so anything that
    // could leave a CSS value or the <style> element is refused.
    else if (/[<>{};"\\]|url\(|@import|expression\(/i.test(v)) problems.push(`${def.label}: contains characters that are not allowed`);
    else clean[k] = v;
  }
  if (problems.length > 0) throw badRequest('Invalid theme values', problems.map((message) => ({ path: 'theme', message })));
  writeJsonSetting(ws, themeKey(id), clean);
}

/** Every rule a pack must satisfy (§9.1): files, sizes, types, pack.json, templates, safety. */
export function validatePack(files: Map<string, Buffer>): PackProblem[] {
  const problems: PackProblem[] = [];
  let total = 0;
  if (files.size > TEMPLATE_LIMITS.files) problems.push({ file: '', message: `At most ${TEMPLATE_LIMITS.files} files` });
  for (const [file, content] of files) {
    total += content.length;
    if (!isSafeEntryName(file) || file.split('/').length > 2 || (file.includes('/') && !file.startsWith('assets/'))) problems.push({ file, message: 'Files must be at the top level or in assets/' });
    const ext = file.split('.').pop()!.toLowerCase();
    if (!(TEMPLATE_FILE_TYPES as readonly string[]).includes(ext)) problems.push({ file, message: `File type .${ext} is not allowed` });
    if (content.length > TEMPLATE_LIMITS.fileBytes) problems.push({ file, message: `Larger than ${TEMPLATE_LIMITS.fileBytes / 1024} KB` });
    if (ext === 'html' || ext === 'txt' || ext === 'css') {
      const text = content.toString('utf8');
      for (const m of templateSafetyProblems(text)) problems.push({ file, message: m });
      if (ext !== 'css') for (const m of checkTemplate(text)) problems.push({ file, message: m });
    }
    if (ext === 'svg') for (const m of svgProblems(content.toString('utf8'))) problems.push({ file, message: m });
  }
  if (total > TEMPLATE_LIMITS.packBytes) problems.push({ file: '', message: `The pack is larger than ${TEMPLATE_LIMITS.packBytes / 1024 / 1024} MB` });
  for (const required of ['pack.json', 'layout.html', ...TEMPLATE_KINDS.map((k) => `${k}.html`)]) {
    if (!files.has(required)) problems.push({ file: required, message: 'Missing' });
  }
  const layout = files.get('layout.html')?.toString('utf8');
  if (layout && !/\{\{\{\s*content\s*\}\}\}/.test(layout)) problems.push({ file: 'layout.html', message: 'The layout needs a {{{content}}} slot' });
  const announcement = files.get('announcement.html')?.toString('utf8');
  if (announcement && !/\{\{\{\s*content\s*\}\}\}/.test(announcement)) problems.push({ file: 'announcement.html', message: 'Needs a {{{content}}} slot for the composer text' });
  const json = files.get('pack.json');
  if (json) {
    try {
      const meta = packJsonSchema.parse(JSON.parse(json.toString('utf8')));
      for (const [kind, subject] of Object.entries(meta.subjects)) for (const m of checkTemplate(subject)) problems.push({ file: 'pack.json', message: `Subject for ${kind}: ${m}` });
    } catch (err) {
      problems.push({ file: 'pack.json', message: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'Not valid JSON' });
    }
  }
  return problems;
}

function assertValid(files: Map<string, Buffer>) {
  const problems = validatePack(files);
  if (problems.length > 0) throw new AppError(422, 'invalid_pack', 'The template pack has problems', problems);
}

export function listPacks(env: PackEnv, ws: WorkspaceContext): PackSummary[] {
  const active = activePackId(env, ws);
  const out: PackSummary[] = [];
  for (const [ids, builtin] of [
    [builtinIds(env), true],
    [customIds(env, ws), false],
  ] as const) {
    for (const id of ids) {
      try {
        const p = loadPack(env, ws, id);
        out.push({ id, name: p.meta.name, description: p.meta.description, version: p.meta.version, builtin, active: id === active });
      } catch {
        /* an unreadable custom pack is skipped (it can still be deleted) */
      }
    }
  }
  return out;
}

export function packDetail(env: PackEnv, ws: WorkspaceContext, id: string): PackDetail {
  const p = loadPack(env, ws, id);
  const textTypes = new Set(['html', 'txt', 'json', 'css', 'svg']);
  return {
    id,
    name: p.meta.name,
    description: p.meta.description,
    version: p.meta.version,
    builtin: p.builtin,
    active: activePackId(env, ws) === id,
    files: [...p.files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, b]) => ({ path: file, bytes: b.length, text: textTypes.has(file.split('.').pop()!.toLowerCase()) })),
    theme: p.meta.theme as Record<string, ThemeVariable>,
    themeValues: themeValues(ws, p),
    subjects: p.meta.subjects,
  };
}

export function readPackFile(env: PackEnv, ws: WorkspaceContext, id: string, file: string): Buffer {
  const content = loadPack(env, ws, id).files.get(file);
  if (!content) throw notFound('File not found');
  return content;
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';
}

function newCustomId(env: PackEnv, ws: WorkspaceContext, name: string): string {
  const taken = new Set([...builtinIds(env), ...customIds(env, ws)]);
  const base = `custom-${slugify(name)}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Writes a validated set of files as a custom pack, atomically (temp dir + rename). */
function writePack(env: PackEnv, ws: WorkspaceContext, id: string, files: Map<string, Buffer>): void {
  assertValid(files);
  const root = customRoot(env, ws);
  mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.tmp-${id}-${Date.now()}`);
  for (const [file, content] of files) {
    mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
    writeFileSync(path.join(tmp, file), content);
  }
  const final = path.join(root, id);
  const old = existsSync(final) ? `${final}.old-${Date.now()}` : null;
  if (old) renameSync(final, old);
  renameSync(tmp, final);
  if (old) rmSync(old, { recursive: true, force: true });
}

function withName(files: Map<string, Buffer>, name: string): Map<string, Buffer> {
  const meta = JSON.parse(files.get('pack.json')!.toString('utf8')) as Record<string, unknown>;
  const out = new Map(files);
  out.set('pack.json', Buffer.from(`${JSON.stringify({ ...meta, name }, null, 2)}\n`));
  return out;
}

export function duplicatePack(env: PackEnv, ws: WorkspaceContext, fromId: string, name: string): string {
  const source = loadPack(env, ws, fromId);
  const id = newCustomId(env, ws, name);
  writePack(env, ws, id, withName(source.files, name));
  const theme = readJsonSetting(ws, themeKey(fromId));
  if (theme) writeJsonSetting(ws, themeKey(id), theme);
  return id;
}

export function writePackFile(env: PackEnv, ws: WorkspaceContext, id: string, file: string, content: Buffer): void {
  const p = loadPack(env, ws, id);
  if (p.builtin) throw conflict('Built-in packs cannot be edited. Duplicate it first.');
  const files = new Map(p.files);
  files.set(file, content);
  writePack(env, ws, id, files);
}

export function deletePackFile(env: PackEnv, ws: WorkspaceContext, id: string, file: string): void {
  const p = loadPack(env, ws, id);
  if (p.builtin) throw conflict('Built-in packs cannot be edited.');
  if (!file.startsWith('assets/') && !file.endsWith('.txt')) throw badRequest('Only assets and plain-text versions can be removed');
  const files = new Map(p.files);
  if (!files.delete(file)) throw notFound('File not found');
  writePack(env, ws, id, files);
}

export function deletePack(env: PackEnv, ws: WorkspaceContext, id: string): void {
  const where = packDir(env, ws, id);
  if (!where) throw notFound('Template pack not found');
  if (where.builtin) throw conflict('Built-in packs cannot be deleted.');
  if (activePackId(env, ws) === id) writeJsonSetting(ws, ACTIVE_KEY, DEFAULT_PACK_ID);
  rmSync(where.dir, { recursive: true, force: true });
}

/** Upload (§9.1): a .zip pack, or a single .html layout wrapped into a copy of the default pack. */
export async function importPack(env: PackEnv, ws: WorkspaceContext, fileName: string, bytes: Buffer): Promise<string> {
  if (bytes.length > TEMPLATE_LIMITS.packBytes) throw new AppError(413, 'too_large', 'The upload is larger than 2 MB');
  const name = fileName.replace(/\.(zip|html?)$/i, '').slice(0, 60) || 'Uploaded pack';
  if (/\.html?$/i.test(fileName)) {
    const base = loadPack(env, ws, DEFAULT_PACK_ID).files;
    const files = withName(base, name);
    files.set('layout.html', bytes);
    const id = newCustomId(env, ws, name);
    writePack(env, ws, id, files);
    return id;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'subscriberr-pack-'));
  try {
    const zipFile = path.join(tmp, 'upload.zip');
    writeFileSync(zipFile, bytes);
    const out = path.join(tmp, 'x');
    mkdirSync(out);
    try {
      await extractZipSafely(zipFile, out, { maxEntries: TEMPLATE_LIMITS.files + 10, maxTotalBytes: TEMPLATE_LIMITS.packBytes, maxEntryBytes: TEMPLATE_LIMITS.fileBytes });
    } catch (err) {
      if (err instanceof UnsafeZipError) throw badRequest(`Unsafe zip: ${err.message}`);
      throw badRequest('This is not a readable zip file');
    }
    // Accept a zip whose files sit in one top-level folder.
    let root = out;
    const top = readdirSync(out).filter((n) => !n.startsWith('__MACOSX') && !n.startsWith('.'));
    if (top.length === 1 && statSync(path.join(out, top[0]!)).isDirectory()) root = path.join(out, top[0]!);
    const files = new Map([...readTree(root)].filter(([f]) => !f.startsWith('__MACOSX') && !f.split('/').some((p) => p.startsWith('.'))));
    const meta = files.get('pack.json');
    const id = newCustomId(env, ws, meta ? String((JSON.parse(meta.toString('utf8')) as { name?: string }).name ?? name) : name);
    writePack(env, ws, id, files);
    return id;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function exportPack(env: PackEnv, ws: WorkspaceContext, id: string): Promise<Buffer> {
  const p = loadPack(env, ws, id);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  zip.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    zip.on('end', () => resolve());
    zip.on('error', reject);
  });
  for (const [file, content] of p.files) zip.append(content, { name: `${id}/${file}` });
  await zip.finalize();
  await done;
  return Buffer.concat(chunks);
}
