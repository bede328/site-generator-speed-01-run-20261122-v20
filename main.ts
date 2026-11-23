import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking --no-opt');
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const { run } = await import('./solve.js');
const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const input = JSON.parse(readFileSync(inDir + '/cases.json', 'utf8'));
const answers = [];
for (const c of input) answers.push(run(c.input));
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + '/answers.json', JSON.stringify(answers));
