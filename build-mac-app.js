// build-mac-app.js
//
// Drive @electron/packager to assemble a macOS .app bundle from a
// Windows host. We use this instead of `electron-builder --mac` because
// electron-builder 25.x rejects mac builds from non-mac hosts. The
// output `.app` is intentionally UNSIGNED.
//
// Output:  dist/AMMViewer-darwin-x64/AMMViewer.app
// (Subsequent build-mac.bat step tar.gz's this with proper modes.)
//
// CLI:
//   node build-mac-app.js [--arch x64|arm64]

const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

function parseArgs(argv) {
  const args = { arch: 'x64' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arch') args.arch = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['x64', 'arm64'].includes(args.arch)) {
    throw new Error(`--arch must be x64 or arm64 (got: ${args.arch})`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = require('./package.json');

  // Keep the copied tree lean — without this the .app balloons with dev
  // deps + dist artifacts. Patterns are anchored regexes (matched against
  // paths starting with "/"). We KEEP node_modules/ for runtime deps.
  const ignore = [
    /^\/dist($|\/)/,
    /^\/\.git($|\/)/,
    /^\/\.claude($|\/)/,
    /^\/\.vscode($|\/)/,
    /^\/\.idea($|\/)/,
    /^\/AMMViewerContents($|\/)/,
    /^\/.*\.bat$/,
    /^\/.*\.lnk$/,
    /^\/build-mac-app\.js$/,
    /^\/pack-app-bundle\.js$/,
    /^\/pack-exec-tarball\.js$/,
    /^\/.*\.(md|MD|markdown)$/,
    /^\/node_modules\/esbuild($|\/)/,
    /^\/node_modules\/@esbuild($|\/)/,
    /^\/node_modules\/cross-env($|\/)/,
  ];

  const opts = {
    dir: __dirname,
    name: 'AMMViewer',
    platform: 'darwin',
    arch: args.arch,
    out: path.join(__dirname, 'dist'),
    overwrite: true,
    electronVersion: pkg.devDependencies.electron.replace(/^[\^~]/, ''),
    appBundleId: pkg.build && pkg.build.appId ? pkg.build.appId : 'com.arcen.ammviewer',
    appVersion: pkg.version,
    appCategoryType: 'public.app-category.productivity',
    ignore,
    // No --icon: we don't ship an .icns. Add icons/icon.icns and set
    // `icon: path.join(__dirname, 'icons/icon.icns')` here to override.
  };

  console.log('Packaging .app with @electron/packager:');
  console.log(`  name:       ${opts.name}`);
  console.log(`  platform:   ${opts.platform}-${opts.arch}`);
  console.log(`  electron:   ${opts.electronVersion}`);
  console.log(`  bundleId:   ${opts.appBundleId}`);
  console.log(`  out:        ${opts.out}`);
  console.log('');

  const appPaths = await packager(opts);
  for (const p of appPaths) {
    const apps = fs.readdirSync(p).filter((f) => f.endsWith('.app'));
    for (const a of apps) {
      console.log(`Built: ${path.join(p, a)}`);
    }
  }
}

main().catch((err) => {
  console.error('build-mac-app failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
