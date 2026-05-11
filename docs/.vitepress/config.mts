import { defineConfig } from 'vitepress';

// VitePress 2 (alpha) — https://vitepress.dev/
//
// Production deploy: https://bynarek.com/simdra/
// All assets are served from the `/simdra/` path prefix. Local `docs:dev`
// uses the same base — open http://localhost:5173/simdra/ in dev.
export default defineConfig({
  title: 'simdra',
  description:
    'SIMD-accelerated 2D canvas and image manipulation, in a Worker. HTML5 Canvas API + sharp-shaped fluent surface.',
  cleanUrls: true,
  lastUpdated: true,
  base: '/simdra/',
  sitemap: {
    hostname: 'https://bynarek.com/simdra/',
  },

  head: [
    ['meta', { name: 'theme-color', content: '#03a9f4' }],
    ['meta', { name: 'og:type', content: 'website' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Canvas 2D', link: '/canvas/', activeMatch: '/canvas/' },
      { text: 'MicroSharp', link: '/microsharp/', activeMatch: '/microsharp/' },
      { text: 'Examples', link: '/examples/', activeMatch: '/examples/' },
      { text: 'Zig core', link: '/zig/', activeMatch: '/zig/' },
    ],

    sidebar: [
      {
        text: 'Get started',
        collapsed: false,
        items: [
          { text: 'Installation', link: '/installation' },
        ],
      },
      {
        text: 'Canvas 2D',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/canvas/' },
          { text: 'API reference', link: '/canvas/api' },
          { text: 'Compatibility', link: '/canvas/compatibility' },
        ],
      },
      {
        text: 'MicroSharp',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/microsharp/' },
          { text: 'API reference', link: '/microsharp/api' },
        ],
      },
      {
        text: 'Examples',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/examples/' },
          { text: 'Open Graph cards', link: '/examples/og-image' },
          { text: 'Document renderer', link: '/examples/document-render' },
          { text: 'Bar chart', link: '/examples/chart' },
          { text: 'Image resize API', link: '/examples/resize-api' },
          { text: 'Avatar pipeline', link: '/examples/avatar-pipeline' },
          { text: 'Watermark / logo', link: '/examples/watermark' },
          { text: 'Format converter', link: '/examples/format-converter' },
        ],
      },
      {
        text: 'Library integrations',
        collapsed: false,
        items: [
          { text: 'SVG → PNG (canvg)', link: '/examples/canvg' },
          { text: 'PDF → PNG (pdfjs-serverless)', link: '/examples/pdfjs' },
          { text: 'PDF → PNG (unpdf)', link: '/examples/unpdf' },
        ],
      },
      {
        text: 'Zig core',
        collapsed: false,
        items: [
          { text: 'Architecture', link: '/zig/' },
          { text: 'Using from Zig', link: '/zig/api' },
          { text: 'Contributing', link: '/zig/contributing' },
        ],
      },
    ],

    // Replace with the real repo URL when ready.
    socialLinks: [{ icon: 'github', link: 'https://github.com/promentol/simdra' }],

    search: { provider: 'local' },

    outline: { level: [2, 3] },

    footer: {
      message:
        'Released under the MIT License. Vendored stb_truetype + stb_image (public domain).',
    },
  },

  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' },
  },
});
