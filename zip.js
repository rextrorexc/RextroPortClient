// Minimal zip reader/writer on top of node:zlib, so no Python or other tools are needed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function fixName(name, flags) {
  let n = name;
  if (!(flags & 0x800)) {
    try { n = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')); } catch {}
  }
  return n.replace(/\\/g, '/');
}

function extract(zipPath, dest) {
  const buf = fs.readFileSync(zipPath);
  const root = path.resolve(dest);
  const res = { entries: 0, extracted: 0, skipped: [] };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const raw = buf.toString('latin1', p + 46, p + 46 + nlen);
    const name = fixName(flags & 0x800 ? buf.toString('utf8', p + 46, p + 46 + nlen) : raw, flags);
    p += 46 + nlen + elen + clen;
    res.entries++;
    const parts = name.split('/').filter(s => s !== '' && s !== '.');
    if (!parts.length || parts.includes('..') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) { res.skipped.push({ name, why: 'unsafe path' }); continue; }
    const target = path.join(root, ...parts);
    try {
      const mode = (attr >>> 16) & 0xFFFF;
      if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); res.extracted++; continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + csize);
      const content = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
      if (!content) throw new Error('unsupported compression ' + method);
      if ((mode & 0o170000) === 0o120000) {
        fs.rmSync(target, { force: true });
        fs.symlinkSync(content.toString('utf8'), target);
      } else {
        fs.writeFileSync(target, content, { mode: (mode & 0o777) || 0o644 });
      }
      res.extracted++;
    } catch (e) { res.skipped.push({ name, why: e.message }); }
  }
  return res;
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function create(zipPath, srcDir) {
  const fd = fs.openSync(zipPath, 'w');
  let off = 0;
  const w = b => { fs.writeSync(fd, b); off += b.length; };
  const central = [];
  for (const rel of walk(srcDir, srcDir, []).sort()) {
    const full = path.join(srcDir, rel);
    const st = fs.statSync(full);
    const data = fs.readFileSync(full);
    const comp = zlib.deflateRawSync(data);
    const [method, body] = comp.length < data.length ? [8, comp] : [0, data];
    const name = Buffer.from(rel, 'utf8');
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(0x00210000, 10); // fixed 1980-01-01 date, keeps output reproducible
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    central.push({ name, method, crc, csize: body.length, size: data.length, off, mode: st.mode & 0o777 });
    w(h); w(name); w(body);
  }
  const cdStart = off;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x800, 8); h.writeUInt16LE(c.method, 10);
    h.writeUInt32LE(0x00210000, 12); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(((0o100000 | c.mode) << 16) >>> 0, 38); h.writeUInt32LE(c.off, 42);
    w(h); w(c.name);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10);
  e.writeUInt32LE(off - cdStart, 12); e.writeUInt32LE(cdStart, 16);
  w(e);
  fs.closeSync(fd);
}

module.exports = { extract, create };
