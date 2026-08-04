// Build gate — ONE rule, on purpose.
//
// `react-hooks/exhaustive-deps` is the rule that catches the bug class this project keeps
// shipping: a useCallback/useMemo that READS a piece of state which is missing from its dependency
// array, so the callback keeps a stale closure. In SheetPanel that shape is always the same and
// always silent — handleSave compares the stale value against the stored one, finds them equal,
// sends no edit, and the UI still reports the change as saved. The user's edit is simply gone.
// It has landed at least twice: once documented in SheetPanel's own comment ("Previously only
// Wait/Click/RightClick saved it, so edits on Type/Navigate/SelectOption were silently dropped"),
// and again with windowVerb/matchIndex, which was live until this audit found it by hand. The
// plugin names both instantly.
//
// The main config (eslint.config.js) stays as it was: it carries the whole recommended set, which
// on this codebase reports ~68 problems, most of them react-refresh/HMR ergonomics and the new
// React-Compiler rules (refs / immutability / purity / set-state-in-effect) firing on code that
// works. Those are worth reviewing, not worth blocking a build over. So the gate is separate and
// narrow rather than "make everything clean", which is the version that never gets adopted.
//
// Pre-existing violations are recorded in eslint-hooks-suppressions.json (generated with
// --suppress-all). That makes this a RATCHET: today's count is frozen and any NEW one fails the
// build. To clear one, fix it and run `npm run lint:hooks:prune`.
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.base, reactHooks.configs.flat.recommended],
    // Silencing rules above leaves their existing eslint-disable comments "unused", which would
    // otherwise report here as noise about rules this gate does not even judge.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The gate itself.
      'react-hooks/exhaustive-deps': 'error',
      // Everything else the recommended set turns on is silenced HERE (not in the main config,
      // where it stays visible to `npm run lint`) so the gate fails for exactly one reason.
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/rules-of-hooks': 'error', // fundamental and already clean — keep it guarded
    },
  },
])
