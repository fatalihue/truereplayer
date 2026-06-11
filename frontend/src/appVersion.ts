import pkg from '../package.json';

// Single source of truth for the version shown in the UI (StatusBar, empty
// states). Reads package.json at build time, so the version-bump checklist
// only needs to touch package.json — no hardcoded display strings to chase.
export const APP_VERSION = `v${pkg.version}`;
