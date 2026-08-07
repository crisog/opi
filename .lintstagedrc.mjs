const quote = (filename) => JSON.stringify(filename);

const commandForFiles = ({ command, filenames }) => {
  if (filenames.length === 0) return [];
  return [`${command} ${filenames.map(quote).join(' ')}`];
};

const lintAndFormat = (filenames) => [
  ...commandForFiles({ command: 'eslint --fix --no-warn-ignored', filenames }),
  ...commandForFiles({ command: 'prettier --write', filenames })
];

export default {
  '**/*.{js,jsx,mjs,cjs}': lintAndFormat,
  '**/*.{ts,tsx}': (filenames) => [...lintAndFormat(filenames), 'npm run typecheck'],
  '**/*.{json,jsonc,md,yaml,yml}': (filenames) => commandForFiles({ command: 'prettier --write', filenames })
};
