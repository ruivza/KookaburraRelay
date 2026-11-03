import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Rest destructuring is how fields are dropped from public objects.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // Input validators match control characters on purpose, to reject them.
      'no-control-regex': 'off',
      // Provider and storage errors are mapped to fixed reason codes; their causes are not carried along.
      'preserve-caught-error': 'off',
    },
  },
];
