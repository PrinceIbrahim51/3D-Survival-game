// Collects everything the browser needs into public/ so a static host or CDN
// can serve it (used by the Vercel deployment; `npm start` does not need it).
//
//   public/                 <- client/
//   public/shared/          <- shared/        (code used by client and server)
//   public/vendor/three/    <- three.js module

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'client'), out, { recursive: true });
fs.cpSync(path.join(root, 'shared'), path.join(out, 'shared'), { recursive: true });
const three = path.join(out, 'vendor', 'three', 'build');
fs.mkdirSync(three, { recursive: true });
// The minified build is a drop-in replacement and roughly half the download.
fs.copyFileSync(path.join(root, 'node_modules', 'three', 'build', 'three.module.min.js'), path.join(three, 'three.module.js'));

let files = 0;
let bytes = 0;
for (const entry of fs.readdirSync(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  files++;
  bytes += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
}
console.log(`public/ ready: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
