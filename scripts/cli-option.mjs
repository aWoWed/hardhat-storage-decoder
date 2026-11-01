/** The value after a flag on this process's command line, or `undefined` when the flag is absent. */
export const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
