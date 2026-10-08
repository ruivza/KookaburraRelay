import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

// Check the source, browser modules and test fixtures without executing them.
for (const directory of ['.', 'test', 'scripts']) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${entry.name}`], {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
