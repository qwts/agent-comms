// Fixed running-package metadata, read once at module initialization. Missing
// packaging metadata never prevents startup; this is not artifact provenance.
import { readFileSync } from 'node:fs';
import { diagnosticBuildVersion } from './diagnostic-profile.mjs';

export const RUNNING_BUILD = Object.freeze((() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (diagnosticBuildVersion(version)) return { buildVersion: version, buildSource: 'running' };
  } catch { /* Inspection and broker startup survive unavailable metadata. */ }
  return { buildVersion: null, buildSource: 'unknown' };
})());
