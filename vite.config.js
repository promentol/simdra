import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zigar from 'rollup-plugin-zigar';
import dts from 'vite-plugin-dts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vite handles ONLY the `simdra/wasm` build (Workers / Edge / browsers).
// The `simdra/core` (Node) build is produced by node-zigar's standalone
// loader + tsc — see `build:core` in package.json.
//
// Output:
//   dist/wasm/index.mjs        — JS entry, expects an injected WebAssembly.Module
//   dist/wasm/simdra.wasm      — sibling asset (takumi-js style)
//   dist/wasm/index.d.ts       — bundled types
//
// Consumer (Cloudflare Workers, Vercel Edge, etc.):
//   import { initSync, createCanvas } from 'simdra/wasm';
//   import wasm from 'simdra/wasm/simdra.wasm';   // pre-compiled by the runtime
//   initSync(wasm);                                // module-init scope, sync
//
// `initSync` is required because Workers forbids `WebAssembly.compile()` from
// raw bytes — but `new WebAssembly.Instance(precompiledModule, imports)` is
// allowed and synchronous. zigar's auto-init does the (forbidden) compile, so
// the `injectInit` transform below strips it and replaces with `initSync`.
export default defineConfig({
  plugins: [
    zigar({
      optimize: 'ReleaseSmall',
      nodeCompat: false,
      useLibc: true,
      embedWASM: false,
      topLevelAwait: false,
      evalBranchQuota: 4000000,
    }),
    injectInit(),
    dts({
      tsconfigPath: resolve(__dirname, 'tsconfig.build.json'),
      rollupTypes: true,
      include: ['src/**/*.ts', 'src/**/*.d.ts'],
      entryRoot: 'src',
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    outDir: 'dist/wasm',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        // Stable asset name: `import wasm from 'simdra/wasm/simdra.wasm'`.
        assetFileNames: 'simdra.wasm',
      },
    },
  },
});

// Strips zigar's auto-init triplet — the source IIFE, `env.loadModule(...)`,
// and `env.linkVariables(...)` — and injects an exported `__initSync(module)`
// that synchronously instantiates a pre-compiled `WebAssembly.Module`. This
// mirrors what zigar's `loadModule` does, but skips the (forbidden) compile
// step. Bytes path stays via the async `__init(input)` for Node/browser use.
function injectInit() {
  return {
    name: 'simdra-inject-init',
    transform(code, id) {
      if (!/\.(zig|zigar)(\?.*)?$/.test(id)) return null;

      const sourceRe = /(?:const|var|let) source = \(async \(\) => \{[\s\S]+?\}\)\(\);\s*/;
      const loadRe = /env\.loadModule\(source, (\{[\s\S]*?\})\);\s*/;
      const linkRe = /env\.linkVariables\((true|false)\);\s*/;

      const sourceMatch = code.match(sourceRe);
      const loadMatch = code.match(loadRe);
      const linkMatch = code.match(linkRe);
      if (!sourceMatch || !loadMatch || !linkMatch) {
        this.warn('simdra-inject-init: zigar auto-init pattern not found');
        return null;
      }

      const opts = loadMatch[1].replace(/\s+/g, '');
      const lv = linkMatch[1];

      const initFns = `
let __simdraReady = false;

// Synchronous init from a pre-compiled WebAssembly.Module — Workers-safe
// when invoked at module-init scope (no WebAssembly.compile, no async I/O).
export function __initSync(mod) {
  if (__simdraReady) return;
  if (!(mod instanceof WebAssembly.Module)) {
    throw new TypeError("simdra/wasm: initSync(module) — pass a WebAssembly.Module (e.g. import wasm from 'simdra/wasm/simdra.wasm')");
  }
  const opts = ${opts};
  const { memoryInitial, memoryMax, tableInitial, multithreaded } = env.options = opts;
  env.executable = mod;
  const fns = env.exportFunctions();
  const e = {}, wasi = {}, wasiPreview = {};
  const imports = env.exportedModules = { env: e, wasi, wasi_snapshot_preview1: wasiPreview };
  for (const { module: m, name, kind } of WebAssembly.Module.imports(mod)) {
    if (kind !== 'function') continue;
    if (m === 'env') e[name] = fns[name] ?? (() => {});
    else if (m === 'wasi_snapshot_preview1') {
      wasiPreview[name] = env.getWASIHandler(name);
      if (name === 'fd_write') wasiPreview.fd_write_stderr = env.getWASIHandler('fd_write_stderr');
    } else if (m === 'wasi') wasi[name] = env.getThreadHandler?.(name) ?? (() => {});
  }
  if (memoryInitial) {
    env.memory = e.memory = new WebAssembly.Memory({ initial: memoryInitial, maximum: memoryMax, shared: !!multithreaded });
  }
  if (tableInitial) {
    env.table = e.__indirect_function_table = new WebAssembly.Table({ initial: tableInitial, element: 'anyfunc', shared: !!multithreaded });
  }
  env.initialTableLength = tableInitial;
  const instance = env.instance = new WebAssembly.Instance(mod, imports);
  env.importFunctions(instance.exports);
  env.initializeCustomWASI();
  env.initialize();
  env.initPromise = Promise.resolve();
  env.linkVariables(${lv});
  __simdraReady = true;
}

// Async init for environments where compile-from-bytes is allowed (Node,
// browsers). Accepts ArrayBuffer / TypedArray / Response / Module / promise.
export async function __init(input) {
  if (__simdraReady) return;
  if (input instanceof WebAssembly.Module) { __initSync(input); return; }
  let src;
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) src = input;
  else if (input && (input[Symbol.toStringTag] === 'Response' || typeof input.arrayBuffer === 'function')) src = input;
  else if (input && typeof input.then === 'function') src = await input;
  else throw new TypeError('simdra/wasm: init(input) — expected ArrayBuffer, TypedArray, Response, WebAssembly.Module, or a promise resolving to one');
  const suffix = (src && src[Symbol.toStringTag] === 'Response') ? 'Streaming' : '';
  const mod = await WebAssembly['compile' + suffix](src);
  __initSync(mod);
}
`;

      let out = code
        .replace(sourceRe, '')
        .replace(loadRe, '')
        .replace(linkRe, '');
      out = out.replace(
        /(env\.recreateStructures\([\s\S]+?\);\s*)/,
        `$1\n${initFns}\n`,
      );
      return { code: out, map: null };
    },
  };
}
