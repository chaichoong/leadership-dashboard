// Git's repository variables never reach a test (2 Oct 2026).
//
// A git hook runs with GIT_DIR (and GIT_INDEX_FILE, GIT_WORK_TREE and the rest)
// pointing at the real repository. Many tests here build a throwaway repository
// in a temp folder and pass `{ ...process.env }` to git. With those variables
// inherited, `git init`, `git config`, `git commit` and `git push` in the temp
// folder act on the REAL repository: on 2 Oct 2026 the pre-push gate, started
// by a push to main from a worktree, set the shared config to `bare = true`,
// switched hooks off, moved a branch on to fixture commits and pushed a fixture
// branch to GitHub. scripts/pre-push now clears them before it starts anything;
// this clears them again inside every test file, so a run started from any
// other hook (or `git rebase --exec npm test`) is safe too.
//
// The list is `git rev-parse --local-env-vars`, plus the numbered config pairs
// that GIT_CONFIG_COUNT announces. Identity variables (GIT_AUTHOR_NAME and the
// like) are not repository variables and are left alone.
import { clearGitLocalEnv } from './git-local-env.js';

clearGitLocalEnv();
