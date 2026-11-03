#!/usr/bin/env node
// Minimal asar reader: list / extract without loading the whole archive.
// usage:
//   node asar-tool.mjs ls  <asar> [filterRegex]
//   node asar-tool.mjs cat <asar> <internalPath> [outFile]

import fs from 'node:fs';
import path from 'node:path';

function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const first = head.readUInt32LE(0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonSize);
  fs.readSync(fd, buf, 0, jsonSize, 16);
  fs.closeSync(fd);
  const json = JSON.parse(buf.toString('utf8'));
  // data starts at 8 (pickle prefix) + headerSize, aligned to 4
  let dataStart = 8 + headerSize;
  if (dataStart % 4 !== 0) dataStart += 4 - (dataStart % 4);
  return { json, dataStart, first };
}

function* walk(node, prefix = '') {
  if (!node.files) {
    yield { path: prefix, size: node.size ?? 0, offset: node.offset ?? null, unpacked: !!node.unpacked };
    return;
  }
  for (const [name, child] of Object.entries(node.files)) {
    yield* walk(child, prefix ? `${prefix}/${name}` : name);
  }
}

const [cmd, asarPath, ...rest] = process.argv.slice(2);
if (!cmd || !asarPath) {
  console.error('usage: node asar-tool.mjs ls|cat <asar> [...]');
  process.exit(2);
}

const { json, dataStart } = readHeader(asarPath);

if (cmd === 'ls') {
  const re = rest[0] ? new RegExp(rest[0], 'i') : null;
  let count = 0, bytes = 0;
  const rows = [];
  for (const f of walk(json)) {
    if (f.offset === null && !f.unpacked) continue;
    count++; bytes += f.size;
    if (!re || re.test(f.path)) rows.push(f);
  }
  rows.sort((a, b) => b.size - a.size);
  console.log(`# dataStart=${dataStart} entries=${count} totalBytes=${bytes} matched=${rows.length}`);
  for (const r of rows.slice(0, 80)) {
    console.log(`${String(r.size).padStart(12)}  ${r.unpacked ? 'UNPACKED ' : ''}${r.path}`);
  }
  if (rows.length > 80) console.log(`... ${rows.length - 80} more`);
} else if (cmd === 'cat') {
  const internal = rest[0];
  const outFile = rest[1];
  if (!internal) { console.error('usage: cat <asar> <internalPath> [outFile]'); process.exit(2); }
  let node = json;
  for (const part of internal.split('/')) {
    node = node.files && node.files[part];
    if (!node) { console.error('not found:', internal); process.exit(3); }
  }
  if (node.files) { console.error('is a directory'); process.exit(3); }
  const size = Number(node.size ?? 0);
  if (node.unpacked) {
    console.error('file is unpacked; read from app.asar.unpacked/' + internal);
    process.exit(4);
  }
  const fd = fs.openSync(asarPath, 'r');
  const buf = Buffer.alloc(size);
  let read = 0;
  const base = dataStart + Number(node.offset);
  while (read < size) {
    const n = fs.readSync(fd, buf, read, size - read, base + read);
    if (!n) break;
    read += n;
  }
  fs.closeSync(fd);
  if (outFile) {
    fs.writeFileSync(outFile, buf);
    console.log(`wrote ${outFile} (${size} bytes)`);
  } else {
    process.stdout.write(buf);
  }
} else {
  console.error('unknown command:', cmd);
  process.exit(2);
}
