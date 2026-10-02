// The list of git's repository variables and the function that clears them.
// No side effects on import: tests/setup-git-env.js is what calls it for every
// test file, and tests/push-gate-git-env.test.js imports this to test it.
export const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

export function clearGitLocalEnv(env = process.env) {
  for (const k of Object.keys(env)) {
    if (GIT_LOCAL_ENV_VARS.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  }
  return env;
}

