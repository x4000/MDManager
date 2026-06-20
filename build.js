const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const rendererConfig = {
  entryPoints: [path.join(__dirname, 'src', 'renderer', 'index.jsx')],
  bundle: true,
  outfile: path.join(__dirname, 'src', 'renderer', 'bundle.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.js': 'js' },
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

if (isWatch) {
  esbuild.context(rendererConfig)
    .then((ctx) => {
      ctx.watch();
      console.log('Watching for changes...');
    })
    .catch(() => process.exit(1));
} else {
  esbuild.build(rendererConfig)
    .then(() => console.log('Build complete.'))
    .catch(() => process.exit(1));
}
