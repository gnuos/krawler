import globals from 'globals'
import pluginJs from '@eslint/js'

/** @type { import('eslint').Linter.Config[] } */
export default [
  { files: ['**/*.{js,mjs,cjs,ts}'] },
  { files: ['**/*.js'], languageOptions: { sourceType: 'script' } },
  { ignores: ['.git', 'node_modules', 'dist'] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  {
    rules: {
      'no-this-alias': 0,
      'no-unused-vars': 0,
      'no-unused-vars': 0
    }
  }
]
