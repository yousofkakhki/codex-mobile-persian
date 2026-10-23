import fs from 'node:fs/promises';
import { verifyRelease } from '../lib/release-integrity.mjs';

const build = JSON.parse(await fs.readFile(new URL('../.work/build-result.json', import.meta.url), 'utf8'));
const report = await verifyRelease(build);
await fs.writeFile(new URL('../evidence/integrity-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
