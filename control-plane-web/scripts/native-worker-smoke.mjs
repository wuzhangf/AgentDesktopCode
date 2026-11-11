import {build} from 'vite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

await build({configFile:false,publicDir:false,build:{
  ssr:resolve('verification/native-worker/consumer.ts'),outDir:'.local/native-worker-consumer',emptyOutDir:false,
  rollupOptions:{output:{entryFileNames:'consumer.mjs'}},
}});
await import(pathToFileURL(resolve('.local/native-worker-consumer/consumer.mjs')).href);
