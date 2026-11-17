const { execFileSync } = require("node:child_process");
const path = require("node:path");

const websiteExport = path.resolve(__dirname, "../apps/website/out");

// gh-pages' default cleanup skips dotfiles, including source files carried
// over when it creates the publishing branch from the default branch.
module.exports = function prunePagesCheckout(git) {
  const stalePaths = execFileSync(
    git.cmd,
    ["--work-tree", websiteExport, "ls-files", "--deleted", "-z"],
    { cwd: git.cwd },
  );
  if (stalePaths.length) {
    execFileSync(
      git.cmd,
      [
        "--literal-pathspecs",
        "rm",
        "-f",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { cwd: git.cwd, input: stalePaths },
    );
  }
};
