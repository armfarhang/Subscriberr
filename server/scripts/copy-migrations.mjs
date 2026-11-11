// Copies the hand-authored SQL migrations next to the compiled JS.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const to = fileURLToPath(new URL('../dist/db/migrations', import.meta.url));
cpSync(from, to, { recursive: true });
