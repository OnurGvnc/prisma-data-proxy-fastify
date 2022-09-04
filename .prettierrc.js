/**
 * @type {import('prettier').Options}
 */
const prettierOptions = {
  tabWidth: 2,
  quoteProps: 'as-needed',
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 80,
  overrides: [
    {
      files: '*.css',
      options: {
        printWidth: 50,
        proseWrap: 'always',
      },
    },
    {
      files: '*.html',

      options: {
        printWidth: 240,
      },
    },
  ],
}

module.exports = prettierOptions
