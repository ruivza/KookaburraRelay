import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// Check the source, browser modules and test fixtures without executing them.
const root=fileURLToPath(new URL('../',import.meta.url));
for (const directory of ['src', 'public', 'test', 'scripts']) {
  const path=join(root,directory);
  for (const entry of await readdir(path, {withFileTypes: true})) {
    if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(path,entry.name)], {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
