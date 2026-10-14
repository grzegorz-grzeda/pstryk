import { readFileSync } from 'node:fs';

/** The running version, from package.json (SemVer 2.0.0). */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
