const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const R = require('./rules');
const Z = require('./zip');

const PORT = process.env.PORT || 3000;
const WORK = path.join(__dirname, 'work');
const WIN = process.platform === 'win32';
// JDK 21 for the optional build: JAVA_HOME if set, else the usual Linux path, else whatever `java` is on PATH.
const JAVA21 = process.env.JAVA_HOME || (fs.existsSync('/usr/lib/jvm/java-21-openjdk') ? '/usr/lib/jvm/java-21-openjdk' : '');
fs.mkdirSync(WORK, { recursive: true });
const jobs = {};

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const walk = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
};
const safe = (root, rel) => {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('bad path');
  let real = p;
  try { real = fs.realpathSync(p); } catch {}
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('bad path');
  return p;
};
const emit = (job, ev) => { job.events.push(ev); job.clients.forEach(c => c.write(`data: ${JSON.stringify(ev)}\n\n`)); };

function detect(files, read) {
  const has = f => files.some(x => x.endsWith(f));
  const kinds = [];
  if (has('fabric.mod.json')) kinds.push('fabric');
  if (has('mods.toml') || has('neoforge.mods.toml')) kinds.push(has('neoforge.mods.toml') ? 'neoforge' : 'forge');
  if (!kinds.length) kinds.push('standalone');
  return kinds;
}

async function fabricVersions(mc) {
  const out = {};
  const get = async u => (await fetch(u, { signal: AbortSignal.timeout(8000) }));
  try {
    const [yarn, loader] = await Promise.all([
      get(`https://meta.fabricmc.net/v2/versions/yarn/${mc}`).then(r => r.json()),
      get('https://meta.fabricmc.net/v2/versions/loader').then(r => r.json()),
    ]);
    out.yarn = yarn[0]?.version; out.loader = loader.find(l => l.stable)?.version;
  } catch {}
  try {
    const xml = await (await get('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml')).text();
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
    const exact = all.filter(v => v.endsWith('+' + mc));
    const minor = all.filter(v => v.endsWith('+' + mc.split('.').slice(0, 2).join('.')));
    const vs = exact.length ? exact : minor;
    out.api = vs[vs.length - 1];
  } catch {}
  return out;
}

const NEEDS_TEXT = /^import\s+net\.minecraft\.text\.Text;/m;
const hasImport = (t, cls) => new RegExp(`^import\\s+net\\.minecraft\\.text\\.(${cls}|\\*);`, 'm').test(t);
function addImport(t, cls, eol) {
  const line = `import net.minecraft.text.${cls};`;
  if (hasImport(t, cls)) return t;
  const imps = [...t.matchAll(/^import\s[^\n]*;[ \t]*\r?$/gm)];
  if (imps.length) { const l = imps[imps.length - 1]; const at = l.index + l[0].length; return t.slice(0, at) + eol + line + t.slice(at); }
  const pk = t.match(/^package\s[^\n]*;[ \t]*\r?$/m);
  if (pk) { const at = pk.index + pk[0].length; return t.slice(0, at) + eol + eol + line + t.slice(at); }
  return t;
}
function dropImport(t, cls) {
  return t.replace(new RegExp(`^import\\s+net\\.minecraft\\.text\\.${cls};[ \\t]*\\r?\\n`, 'm'), '');
}

// Text constructors: pure rename, behavior identical, applied to every file (also protected ones).
function portTextApi(text, target, notes) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let t = text;
  const pairs = [['LiteralText', 'literal'], ['TranslatableText', 'translatable']];
  if (R.cmp(target, '1.19') >= 0) {
    for (const [cls, fn] of pairs) {
      if (!new RegExp(`\\b${cls}\\b`).test(t)) continue;
      const stripped = t.replace(new RegExp(`^import\\s[^\\n]*${cls};[^\\n]*$`, 'm'), '');
      const uses = stripped.match(new RegExp(`\\b${cls}\\b`, 'g')) || [];
      const ctors = stripped.match(new RegExp(`new\\s+${cls}\\s*\\(`, 'g')) || [];
      if (uses.length !== ctors.length) { notes.push({ line: 0, note: `${cls} used as type: edit manually (not changed)` }); continue; }
      t = t.replace(new RegExp(`new\\s+${cls}\\s*\\(`, 'g'), `Text.${fn}(`);
      t = dropImport(t, cls);
      t = addImport(t, 'Text', eol);
    }
  } else if (NEEDS_TEXT.test(t) || /^import\s+net\.minecraft\.text\.\*;/m.test(t)) {
    for (const [cls, fn] of pairs) {
      const re = new RegExp(`\\bText\\.${fn}\\s*\\(`, 'g');
      if (!re.test(t)) continue;
      t = t.replace(new RegExp(`\\bText\\.${fn}\\s*\\(`, 'g'), `new ${cls}(`);
      t = addImport(t, cls, eol);
    }
  }
  return t;
}

function portSource(rel, text, target) {
  const flags = [], skipped = [];
  text.split('\n').forEach((line, i) => {
    for (const f of R.FLAG_RULES) if (R.cmp(target, f.since) >= 0 && f.re.test(line)) flags.push({ line: i + 1, note: f.note });
    if (R.PROTECTED_LINE.test(line) && /\b(LiteralText|TranslatableText|Text\.(literal|translatable))\b/.test(line))
      skipped.push({ line: i + 1, note: 'text constructor on logic line: renamed only, logic untouched' });
  });
  const notes = [];
  const out = portTextApi(text, target, notes);
  notes.forEach(n => flags.push(n));
  return { text: out, flags, skipped: out !== text ? skipped : [] };
}

// Targeted in-place edits: formatting, comments and templating (${...}) stay as the client had them.
function portBuild(rel, text, target, info) {
  const base = path.basename(rel);
  const fv = info.fv || {};
  const flags = [];
  let t = text;
  const keyed = (re, val) => { if (val) t = t.replace(re, (m, p) => p + val); };
  if (base === 'gradle.properties') {
    keyed(/^(minecraft_version\s*=\s*).*$/m, target);
    keyed(/^(yarn_mappings\s*=\s*).*$/m, fv.yarn);
    keyed(/^(loader_version\s*=\s*).*$/m, fv.loader);
    keyed(/^(fabric(?:_api)?_version\s*=\s*).*$/m, fv.api);
  }
  if (/build\.gradle(\.kts)?$/.test(base)) {
    // Java level only ever raised, never lowered: client code may already need a newer one.
    const up = (cur) => { const n = Number(String(cur).replace(/^1_/, '')); return n >= info.java ? null : info.java; };
    t = t.replace(/(JavaVersion\.VERSION_)(\w+)/g, (m, p, v) => { const n = up(v); return n ? `${p}${n}` : m; })
      .replace(/(options\.release\s*=\s*)(\d+)/g, (m, p, v) => { const n = up(v); return n ? `${p}${n}` : m; })
      .replace(/(JavaLanguageVersion\.of\()(\d+)/g, (m, p, v) => { const n = up(v); return n ? `${p}${n}` : m; })
      .replace(/(com\.mojang:minecraft:)[^"'\s)$]+/g, `$1${target}`);
    // Loom 0.x/1.0-1.5 do not run on Gradle 8.5+/JDK 21 or lack newer MC support.
    t = t.replace(/(id\s*\(?\s*['"]fabric-loom['"]\s*\)?\s*version\s*\(?\s*['"])(\d+\.\d+)([^'"]*)(['"])/g, (m, p, v, rest, q) => R.cmp(v, '1.9') < 0 || (R.cmp(v, '1.9') === 0 && !/SNAPSHOT/.test(rest)) ? `${p}1.9-SNAPSHOT${q}` : m);
    if (fv.yarn) t = t.replace(/(net\.fabricmc:yarn:)[^:"'\s)$]+/g, `$1${fv.yarn}`);
    if (fv.loader) t = t.replace(/(net\.fabricmc:fabric-loader:)[^"'\s)$]+/g, `$1${fv.loader}`);
    if (fv.api) t = t.replace(/(net\.fabricmc\.fabric-api:fabric-api:)[^"'\s)$]+/g, `$1${fv.api}`);
    if (/net\.minecraftforge|neoforged/.test(t)) flags.push({ line: 0, note: 'Forge/NeoForge version in build.gradle: set manually' });
  }
  if (base === 'fabric.mod.json') {
    t = t.replace(/("minecraft"\s*:\s*")(?![^"]*\$\{)[^"]*(")/, `$1~${target}$2`);
    t = t.replace(/("java"\s*:\s*")(?![^"]*\$\{)>=(\d+)(")/, (m, p, v, q) => Number(v) >= info.java ? m : `${p}>=${info.java}${q}`);
  }
  if (base === 'pack.mcmeta') t = t.replace(/("pack_format"\s*:\s*)\d+/, `$1${info.packFormat}`);
  if (/mods\.toml$/.test(base)) t = t.replace(/(modId\s*=\s*"minecraft"[\s\S]*?versionRange\s*=\s*)"[^"]*"/, `$1"[${target}]"`);
  return { text: t, flags, skipped: [] };
}


const GRADLE = '8.12.1';
const GH = `https://raw.githubusercontent.com/gradle/gradle/v${GRADLE}`;
async function fetchTo(url, dest, mode) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()), { mode });
}
// Makes sure the output has a working Gradle wrapper that runs on JDK 21 (Gradle >= 8.5).
async function ensureWrapper(outDir, job) {
  const hasGradle = fs.existsSync(path.join(outDir, 'build.gradle')) || fs.existsSync(path.join(outDir, 'build.gradle.kts'));
  if (!hasGradle) return;
  const props = path.join(outDir, 'gradle/wrapper/gradle-wrapper.properties');
  const dist = `distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE}-bin.zip`;
  try {
    const jar = path.join(outDir, 'gradle/wrapper/gradle-wrapper.jar');
    if (!fs.existsSync(path.join(outDir, 'gradlew'))) {
      await fetchTo(`${GH}/gradlew`, path.join(outDir, 'gradlew'), 0o755);
      await fetchTo(`${GH}/gradlew.bat`, path.join(outDir, 'gradlew.bat'), 0o644);
      emit(job, { type: 'log', msg: 'gradlew oluşturuldu' });
    }
    if (!fs.existsSync(jar)) await fetchTo(`${GH}/gradle/wrapper/gradle-wrapper.jar`, jar, 0o644);
    if (!fs.existsSync(props)) {
      fs.writeFileSync(props, `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\n${dist}\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n`);
    } else {
      const cur = fs.readFileSync(props, 'utf8');
      const m = cur.match(/gradle-([\d.]+)-/);
      if (m && R.cmp(m[1], '8.5') < 0) {
        fs.writeFileSync(props, cur.replace(/^distributionUrl=.*$/m, dist));
        emit(job, { type: 'log', msg: `Gradle wrapper ${m[1]} -> ${GRADLE} (JDK 21 için gerekli)` });
      }
    }
    fs.chmodSync(path.join(outDir, 'gradlew'), 0o755);
  } catch (e) { emit(job, { type: 'log', msg: 'gradlew oluşturulamadı (ağ?): ' + e.message }); }
}

const SKIP_DIRS = /(^|\/)(\.git|\.gradle|build|run|out|node_modules|\.idea)\//;
const TEXT_EXT = /\.(java|kt|gradle|kts|properties|json|mcmeta|toml)$/;
function decodeUtf8(buf) { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return null; } }

async function runPort(job, target) {
  const info = R.VERSIONS.find(v => v.mc === target);
  if (!info) return emit(job, { type: 'error', msg: 'unsupported version' });
  const outDir = path.join(job.dir, 'out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(job.src, outDir, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  emit(job, { type: 'log', msg: `Hedef ${target} (Java ${info.java}, pack_format ${info.packFormat})` });
  const fv = job.kinds.includes('fabric') ? await fabricVersions(target) : {};
  if (job.kinds.includes('fabric')) emit(job, { type: 'log', msg: fv.yarn ? `Fabric yarn ${fv.yarn}, loader ${fv.loader}, api ${fv.api || '?'}` : 'Fabric meta erişilemedi: yarn/loader/api değişmedi' });
  const totals = { changed: 0, flags: 0, skipped: 0, errors: 0 };
  job.report = [];
  const files = walk(job.src).sort();
  for (const rel of files) {
    emit(job, { type: 'file', path: rel, status: 'working' });
    await new Promise(r => setImmediate(r));
    let res = { text: null, flags: [], skipped: [] }, changed = false, status = 'untouched';
    try {
      const sp = path.join(job.src, rel);
      const st = fs.lstatSync(sp);
      if (st.isFile() && TEXT_EXT.test(rel) && !SKIP_DIRS.test('/' + rel)) {
        const buf = fs.readFileSync(sp);
        const orig = decodeUtf8(buf);
        if (orig === null) { res.flags.push({ line: 0, note: 'not UTF-8: left byte-identical' }); }
        else {
          const bom = orig.charCodeAt(0) === 0xFEFF;
          const body = bom ? orig.slice(1) : orig;
          let r;
          if (/\.java$/.test(rel)) r = portSource(rel, body, target);
          else if (/\.kt$/.test(rel)) r = { text: body, flags: portSource(rel, body, target).flags, skipped: [] };
          else r = portBuild(rel, body, target, { ...info, fv });
          res = r;
          if (r.text !== body) {
            fs.writeFileSync(path.join(outDir, rel), Buffer.from((bom ? '﻿' : '') + r.text, 'utf8'));
            changed = true;
          }
        }
        status = res.flags.length ? 'review' : changed ? 'changed' : 'ok';
      }
    } catch (e) {
      totals.errors++; res.flags.push({ line: 0, note: 'error: ' + e.message + ' (file copied unchanged)' }); status = 'review';
      try { fs.cpSync(path.join(job.src, rel), path.join(outDir, rel), { verbatimSymlinks: true, force: true }); } catch {}
    }
    totals.changed += changed ? 1 : 0; totals.flags += res.flags.length; totals.skipped += res.skipped.length;
    job.report.push({ path: rel, changed, flags: res.flags, skipped: res.skipped });
    emit(job, { type: 'file', path: rel, status, changed, flags: res.flags, skipped: res.skipped });
  }
  await ensureWrapper(outDir, job);
  // Integrity: every source file must exist in output; untouched ones byte-identical.
  const changedSet = new Set(job.report.filter(f => f.changed).map(f => f.path));
  let missing = 0, differ = 0;
  for (const rel of files) {
    const o = path.join(outDir, rel), s = path.join(job.src, rel);
    let lo; try { lo = fs.lstatSync(o); } catch { missing++; emit(job, { type: 'log', msg: `EKSİK: ${rel}` }); continue; }
    if (changedSet.has(rel) || lo.isSymbolicLink()) continue;
    if (!fs.readFileSync(o).equals(fs.readFileSync(s))) { differ++; emit(job, { type: 'log', msg: `FARKLI: ${rel}` }); }
  }
  const extra = walk(outDir).filter(r => !files.includes(r) && !/^(gradlew(\.bat)?|gradle\/wrapper\/.*)$/.test(r));
  emit(job, { type: 'log', msg: `Doğrulama: ${files.length} dosya, ${missing} eksik, ${differ} beklenmeyen fark, ${extra.length} fazla dosya` });
  fs.writeFileSync(path.join(job.dir, 'PORT_REPORT.json'), JSON.stringify({ target, totals, files: job.report.filter(f => f.changed || f.flags.length || f.skipped.length) }, null, 2));
  job.ported = true; job.target = target;
  emit(job, { type: 'done', totals });
}

function runBuild(job) {
  if (job.building) return;
  const out = path.join(job.dir, 'out');
  if (!job.ported) return emit(job, { type: 'log', msg: 'Önce port et' });
  if (!fs.existsSync(path.join(out, 'gradlew'))) return emit(job, { type: 'log', msg: 'gradlew yok (gradle projesi değil): derleme atlandı' });
  // Build in a scratch copy so the client output stays clean (no build/, .gradle/ in the download).
  const tmp = path.join(job.dir, 'buildtmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(out, tmp, { recursive: true, verbatimSymlinks: true });
  fs.chmodSync(path.join(tmp, 'gradlew'), 0o755);
  job.building = true;
  emit(job, { type: 'log', msg: 'Derleniyor (JDK 21, gradlew build -x test)…' });
  const env = { ...process.env };
  if (JAVA21) { env.JAVA_HOME = JAVA21; env.PATH = `${path.join(JAVA21, 'bin')}${path.delimiter}${env.PATH}`; }
  const p = WIN
    ? spawn('cmd.exe', ['/c', 'gradlew.bat', 'build', '-x', 'test', '--console=plain', '--no-daemon'], { cwd: tmp, env })
    : spawn('./gradlew', ['build', '-x', 'test', '--console=plain', '--no-daemon'], { cwd: tmp, env });
  const errs = [];
  const feed = d => d.toString().split('\n').filter(Boolean).forEach(l => { if (/error:|FAILED|What went wrong|Could not|Unsupported/.test(l)) errs.push(l); emit(job, { type: 'build', msg: l }); });
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  p.on('error', e => { job.building = false; emit(job, { type: 'log', msg: 'gradlew başlatılamadı: ' + e.message }); });
  p.on('close', c => {
    job.building = false;
    emit(job, { type: 'log', msg: c === 0 ? 'DERLEME BAŞARILI' : `DERLEME HATALI (çıkış ${c}): ${errs.length} sorun satırı yukarıda` });
    emit(job, { type: 'built', ok: c === 0 });
  });
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks)));
  });
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/(\w+)$/);
    if (req.method === 'GET' && u.pathname === '/api/versions') return send(res, 200, R.VERSIONS);
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      const body = await readBody(req);
      const id = crypto.randomBytes(6).toString('hex');
      const dir = path.join(WORK, id); const src = path.join(dir, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(dir, 'in.zip'), body);
      let ex;
      try { ex = Z.extract(path.join(dir, 'in.zip'), src); }
      catch (e) { throw new Error('zip açılamadı: ' + e.message); }
      const files = walk(src);
      const job = jobs[id] = { id, dir, src, events: [], clients: [], kinds: detect(files) };
      job.extract = ex;
      return send(res, 200, { id, kinds: job.kinds, files, entries: ex.entries, skipped: ex.skipped });
    }
    if (m) {
      const job = jobs[m[1]]; if (!job) return send(res, 404, { error: 'no job' });
      if (m[2] === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        job.events.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
        job.clients.push(res); req.on('close', () => job.clients.splice(job.clients.indexOf(res), 1));
        return;
      }
      if (m[2] === 'port' && req.method === 'POST') {
        const { version } = JSON.parse((await readBody(req, 1e5)).toString());
        job.events.length = 0; runPort(job, version).catch(e => emit(job, { type: 'error', msg: e.message }));
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'report') return send(res, 200, fs.existsSync(path.join(job.dir, 'PORT_REPORT.json')) ? fs.readFileSync(path.join(job.dir, 'PORT_REPORT.json')) : '{}');
      if (m[2] === 'build' && req.method === 'POST') { runBuild(job); return send(res, 200, { ok: true }); }
      if (m[2] === 'file') {
        const rel = u.searchParams.get('path'); const which = u.searchParams.get('v') === 'out' ? 'out' : 'src';
        const p = safe(path.join(job.dir, which), rel);
        return send(res, 200, fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 400000) : '', 'text/plain; charset=utf-8');
      }
      if (m[2] === 'download') {
        if (!job.ported) return send(res, 409, { error: 'not ported' });
        const zip = path.join(job.dir, `ported-${job.target}.zip`);
        Z.create(zip, path.join(job.dir, 'out'));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ported-${job.target}.zip"` });
        return fs.createReadStream(zip).pipe(res);
      }
    }
    if (req.method === 'GET') {
      const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      const p = safe(path.join(__dirname, 'public'), f);
      if (fs.existsSync(p)) return send(res, 200, fs.readFileSync(p), f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
