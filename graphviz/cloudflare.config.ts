// The renderer Worker (src/graphviz/worker.js): Graphviz's dot, a wasm build of it from the
// `graphviz` image of the agents' computers' bucket, run in a SLICC kernel. Deployed from this
// directory, before the inbox Worker, which binds it (`GRAPHVIZ`):
//
//   cd graphviz && npx cf deploy --mode prod
//
// It has no public address: the inbox Worker's service binding is its only way in. Its image
// is in the same bucket as the computers' (`npm run computer:images` puts it there).
import { bindings, defineConfig } from 'cf/config';

const NAMES: Record<string, string> = {
  prod: 'helix-opspile-graphviz',
  stage: 'helix-opspile-graphviz-stage',
};

export default defineConfig(({ mode }) => {
  const deployed = Boolean(mode && NAMES[mode]);
  const suffix = mode === 'prod' ? '' : `-${mode || 'dev'}`;
  return {
    worker: {
      name: deployed ? NAMES[mode as string] : 'helix-opspile-graphviz-dev',
      compatibilityDate: '2026-10-01',
      entrypoint: '../src/graphviz/worker.js',
      previewUrls: false,
      workersDev: false,
      observability: { enabled: true },
      compatibilityFlags: ['nodejs_compat'],
      env: {
        // The images of the agents' computers: dot is the `graphviz` one.
        IMAGES: bindings.r2({ name: `helix-opspile-images${suffix}` }),
        // Dynamic Workers: the kernel's processes, dot among them.
        LOADER: bindings.workerLoader(),
      },
    },
  };
});
