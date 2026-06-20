// pack-app-bundle.js
//
// Walk a directory tree (a macOS .app bundle, OR a Linux unpacked
// Electron directory) and produce a .tar.gz with explicit Unix
// permissions on every entry. Built so the resulting archive launches
// cleanly on Linux/macOS even though it was produced on a Windows host.
//
// Why we can't just `tar -czf` the directory:
//   NTFS has no Unix executable bit. When `tar` reads file stats on
//   Windows, executables come back as 0o666. The Linux and macOS
//   launchers both MUST be 0o755 or the OS refuses to run them. Same for
//   .so / .dylib / .node files, chrome-sandbox, and helper-process
//   launchers. Without forcing those modes ourselves, the cross-built
//   bundle is DOA.
//
// Mode policy (first match wins):
//   - directories                                                 0o755
//   - symlinks                                                    0o777 (target governs)
//   - file content starts with ELF magic   (\x7fELF)              0o755
//   - file content starts with Mach-O magic (any variant)         0o755
//   - file content starts with `#!`        (shebang)              0o755
//   - any path ending in .so / .dylib / .node                     0o755
//   - any path containing /Contents/MacOS/ at any depth           0o755
//   - everything else (resources, plists, .icns, JS, etc.)        0o644
//
// Usage:
//   node pack-app-bundle.js --out dist\AMMViewer-mac.tar.gz \
//                           --root dist\AMMViewer-darwin-x64\AMMViewer.app
//   node pack-app-bundle.js --out dist\AMMViewer-linux.tar.gz \
//                           --root dist\linux-unpacked \
//                           --top-name AMMViewer-linux
//
// The root's basename becomes the top-level directory in the tarball
// unless overridden by --top-name. --app is accepted as a synonym for
// --root (legacy from the mac-only iteration of this script).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;

// ── Magic-byte detection ─────────────────────────────────────────────
function looksExecutableByMagic(absPath) {
  let fd = -1;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n < 2) return false;
    // ELF: 7f 45 4c 46  ("\x7fELF") — Linux / BSD native binaries.
    if (n >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O is recorded with host endianness, so x86_64 / arm64 Macs see
    // it byte-swapped from the "documented" big-endian magic. Both forms
    // occur in real Electron bundles.
    //   feedface / feedfacf            big-endian   (32 / 64 bit)
    //   cefaedfe / cffaedfe            little-endian (32 / 64 bit, swapped)
    //   cafebabe / bebafeca            fat/universal (big / little swapped)
    if (n >= 4) {
      if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa
          && (buf[3] === 0xce || buf[3] === 0xcf)) return true;
      if (buf[3] === 0xfe && buf[2] === 0xed && buf[1] === 0xfa
          && (buf[0] === 0xce || buf[0] === 0xcf)) return true;
      if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) return true;
      if (buf[0] === 0xbe && buf[1] === 0xba && buf[2] === 0xfe && buf[3] === 0xca) return true;
    }
    // Shebang scripts.
    if (buf[0] === 0x23 && buf[1] === 0x21) return true;
    return false;
  } catch (_) {
    return false;
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch (_) {}
  }
}

// ── Mode classification ──────────────────────────────────────────────
function modeForEntry(archivePath, absPath, isDir) {
  if (isDir) return 0o755;
  if (looksExecutableByMagic(absPath)) return 0o755;
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.so') || lower.endsWith('.dylib') || lower.endsWith('.node')) {
    return 0o755;
  }
  const segs = archivePath.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === 'Contents' && segs[i + 1] === 'MacOS') return 0o755;
  }
  return 0o644;
}

// ── POSIX ustar header writer ────────────────────────────────────────
function buildHeader({ name, mode, size, mtime, typeflag = '0' }) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    if (Buffer.byteLength(name, 'utf8') > 255) {
      throw new Error(`Path too long even with prefix split: ${name}`);
    }
    let split = -1;
    for (let i = Math.min(name.length - 1, 155); i > 0; i--) {
      if (name[i] !== '/') continue;
      const prefix = name.slice(0, i);
      const tail = name.slice(i + 1);
      if (Buffer.byteLength(prefix, 'utf8') <= 155
          && Buffer.byteLength(tail, 'utf8') <= 100) {
        split = i;
        break;
      }
    }
    if (split < 0) throw new Error(`Cannot split path for ustar prefix: ${name}`);
    return buildHeaderRaw({
      name: name.slice(split + 1),
      prefix: name.slice(0, split),
      mode, size, mtime, typeflag,
    });
  }
  return buildHeaderRaw({ name, prefix: '', mode, size, mtime, typeflag });
}

function buildHeaderRaw({ name, prefix, mode, size, mtime, typeflag }) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  function writeOctal(value, offset, len, trailing = ' \0') {
    const str = value.toString(8).padStart(len - trailing.length, '0') + trailing;
    header.write(str, offset, len, 'ascii');
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(mode & 0o7777, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12, '\0');
  writeOctal(mtime, 136, 12, ' ');
  header.write('        ', 148, 8, 'ascii'); // chksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(0, 329, 8);
  writeOctal(0, 337, 8);
  if (prefix) header.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return header;
}

function padToBlock(stream, length) {
  const remainder = length % BLOCK_SIZE;
  if (remainder === 0) return;
  stream.write(Buffer.alloc(BLOCK_SIZE - remainder, 0));
}

// ── Directory walk ───────────────────────────────────────────────────
function* walk(root, topName) {
  function* recurse(abs, rel) {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        const target = fs.readlinkSync(childAbs);
        yield { kind: 'symlink', archivePath: `${topName}/${childRel}`, target };
      } else if (e.isDirectory()) {
        yield { kind: 'dir', archivePath: `${topName}/${childRel}/` };
        yield* recurse(childAbs, childRel);
      } else if (e.isFile()) {
        const stat = fs.statSync(childAbs);
        yield {
          kind: 'file',
          archivePath: `${topName}/${childRel}`,
          abs: childAbs,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
        };
      }
    }
  }
  yield { kind: 'dir', archivePath: `${topName}/` };
  yield* recurse(root, '');
}

function buildSymlinkHeader({ name, target, mtime }) {
  const header = buildHeader({
    name,
    mode: 0o777,
    size: 0,
    mtime,
    typeflag: '2',
  });
  if (Buffer.byteLength(target, 'utf8') > 100) {
    throw new Error(`Symlink target too long for ustar: ${target}`);
  }
  header.write(target, 157, 100, 'utf8');
  header.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--root' || a === '--app') args.root = argv[++i];
    else if (a === '--top-name') args.topName = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.out) throw new Error('--out required');
  if (!args.root) throw new Error('--root (or --app) required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPath = path.resolve(args.root);
  const outPath = path.resolve(args.out);
  const topName = args.topName || path.basename(rootPath);

  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${args.root}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outStream = fs.createWriteStream(outPath);
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(outStream);

  let counts = { files: 0, dirs: 0, symlinks: 0, execs: 0 };

  for (const entry of walk(rootPath, topName)) {
    if (entry.kind === 'dir') {
      gzip.write(buildHeader({
        name: entry.archivePath,
        mode: 0o755,
        size: 0,
        mtime: Math.floor(Date.now() / 1000),
        typeflag: '5',
      }));
      counts.dirs++;
    } else if (entry.kind === 'symlink') {
      gzip.write(buildSymlinkHeader({
        name: entry.archivePath,
        target: entry.target,
        mtime: Math.floor(Date.now() / 1000),
      }));
      counts.symlinks++;
    } else {
      const mode = modeForEntry(entry.archivePath, entry.abs, false);
      if ((mode & 0o111) !== 0) counts.execs++;
      gzip.write(buildHeader({
        name: entry.archivePath,
        mode,
        size: entry.size,
        mtime: entry.mtime,
      }));
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(entry.abs);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.on('data', (chunk) => gzip.write(chunk));
      });
      padToBlock(gzip, entry.size);
      counts.files++;
    }
  }

  gzip.write(Buffer.alloc(BLOCK_SIZE * 2, 0));
  gzip.end();

  await new Promise((resolve, reject) => {
    outStream.on('error', reject);
    outStream.on('close', resolve);
  });

  const finalSize = fs.statSync(outPath).size;
  console.log(
    `Packed ${counts.files} files (${counts.execs} executable), `
    + `${counts.dirs} directories, ${counts.symlinks} symlinks.`
  );
  console.log(`Wrote ${outPath} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error('pack-app-bundle failed:', err.message);
  process.exit(1);
});
