// Entry driver for markdown-render-speed-02.
//
// Reads the case set from the input directory (MAKEFUN_INPUT_DIR, or /input
// inside the harness container), renders every case's markdown with the
// parse() implementation from ./parse.js, and writes the HTML strings, in
// the cases' order, as a JSON array to html.json in the output directory
// (MAKEFUN_OUTPUT_DIR, or /output).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const out: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  out[k] = parse(cases[k].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
