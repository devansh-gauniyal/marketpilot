// Skill manifest — kept as a thin re-export from the catalog so existing
// imports (`allowedToolsFor`, `DEFAULT_TOOLS`) keep working unchanged.
//
// The catalog (./catalog.ts) is the new source of truth. This file used to
// contain a hardcoded `skillManifest` object; that data now lives on each
// catalog entry's `allowedTools` field.

export { allowedToolsFor, DEFAULT_TOOLS } from "./catalog";
