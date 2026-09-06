// Inspect tar headers before extracting an approved git archive; no external package required.
const fs = require('node:fs'), zlib = require('node:zlib');
const bytes = zlib.gunzipSync(fs.readFileSync(process.argv[2]));
const seen = new Set();
for (let offset = 0; offset + 512 <= bytes.length;) {
  const header = bytes.subarray(offset, offset + 512); if (header.every(b => b === 0)) break;
  const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
  const name = text(0, 100), prefix = text(345, 500), full = prefix ? `${prefix}/${name}` : name;
  const kind = text(156, 157), size = parseInt(text(124, 136).trim() || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw Error('INVALID_TAR_SIZE');
  // Git archive emits a global pax header with its commit id. It cannot redirect a file path.
  if (kind === 'g') {
    const pax = bytes.subarray(offset + 512, offset + 512 + size).toString('utf8');
    if (!/^\d+ comment=[a-f0-9]{40}\n$/.test(pax)) throw Error('UNEXPECTED_GLOBAL_PAX');
  } else {
    if (!['', '0', '5'].includes(kind) || full.startsWith('/') || full.includes('\\') || full.split('/').includes('..') || /[\r\n]/.test(full) || seen.has(full)) throw Error('UNSAFE_TAR_ENTRY');
    seen.add(full);
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!seen.has('docker-compose.prod.yml') || !seen.has('prisma/schema.prisma')) throw Error('RELEASE_FILES_MISSING');
console.log('APPROVED_ARCHIVE_ENTRIES_SAFE');
