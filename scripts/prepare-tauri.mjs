// Keep the desktop renderer identical to the Electron/mobile renderer. Never stage
// private imports, course_inputs, caches, Electron/node code, or the repository.
import { cp, mkdir, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tauri-dist');
async function verifyDirectory(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing to stage symlink: ${file}`);
    if (entry.isDirectory()) await verifyDirectory(file);
  }
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const directory of ['renderer', 'shared']) {
  const source = join(root, 'src', directory);
  await verifyDirectory(source);
  await cp(source, join(output, directory), {
    recursive: true,
    // Synthetic preview fixtures belong only in the browser development view.
    filter: (file) => basename(file) !== 'mock.js',
  });
}
console.log('Prepared shared renderer in .tauri-dist (renderer/ + shared/ only).');
