// The append-only turn log. One JSON line per turn, so a crash loses at most
// the turn in flight, and a reader can follow the file while the worker runs.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function recordTurn(file, row) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}
