// Electron is a parity/reference build, not the low-footprint target.
import { packager } from '@electron/packager';
const result = await packager({
  dir: '.', name: 'ACORN Widget', platform: 'win32', arch: 'x64',
  out: 'dist', overwrite: true, asar: true,
  // Whitelist runtime files; never package imports, screenshots, logs or user caches.
  ignore: (file) => file !== '' && !/^\/(src|assets|node_modules)(\/|$)/.test(file) && !/^\/(package\.json|package-lock\.json)$/.test(file),
});
console.log(result.join('\n'));
