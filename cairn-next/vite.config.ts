import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sanitizer = path.join(path.dirname(require.resolve('dompurify')), 'purify.es.mjs');
const normalized = (id: string) => id.split('?')[0]!.replaceAll('\\', '/');

export default defineConfig({
  base: './',
  root: '.',
  resolve: {
    alias: [
      {
        find: 'monaco-editor/esm/vs/editor/editor.api.js',
        replacement: 'monaco-editor/editor/editor.api.js',
      },
    ],
  },
  build: { outDir: 'web-dist', emptyOutDir: true },
  optimizeDeps: { exclude: ['monaco-editor'] },
  plugins: [
    {
      name: 'cairn-next-sanitizer',
      enforce: 'pre',
      resolveId(source, importer) {
        // Monaco 0.57 contains a second sanitizer copy outside its npm dependency.
        if (
          source === './dompurify/dompurify.js' &&
          importer &&
          normalized(importer).includes('/monaco-editor/esm/')
        )
          return sanitizer;
        return null;
      },
      generateBundle() {
        const modules = [...this.getModuleIds()].map(normalized);
        if (modules.some((id) => id.endsWith('/browser/dompurify/dompurify.js')))
          this.error('Unpatched embedded sanitizer was bundled.');
        if (
          modules.some((id) => id.endsWith('/browser/domSanitize.js')) &&
          !modules.includes(normalized(sanitizer))
        )
          this.error('Required pinned sanitizer is missing.');
      },
    },
  ],
});
