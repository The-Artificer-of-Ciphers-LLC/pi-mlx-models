# How to release a new version

For maintainers. A release is one manual run of the **Release** workflow, followed by your approval on npm. Nothing releases automatically, and pushing a tag publishes nothing.

## Before you start

- The change you want to release is merged to `main`, and its CI run has finished and passed. The workflow checks this and stops if it hasn't.
- Describe the change under `## Unreleased` in `CHANGELOG.md`, either in the pull request that makes it or just before you release. If you would rather not edit the file, type a one-line note in the workflow's **notes** field; it is used only when the Unreleased section is empty.

## Release

1. Open **Actions → Release → Run workflow** on GitHub, keeping the branch as `main`.
2. Choose the bump: `patch` for fixes, `minor` for new features, `major` for breaking changes.
3. Leave **dry-run** unticked for a real release. Tick it to check everything without staging, committing or tagging.
4. Run it. It takes a few minutes, then waits for your approval (step 5) for up to 30 minutes. The run:
   - checks that it is on `main` and that the ubuntu and macOS tests passed on that commit
   - bumps the version and moves the Unreleased changelog entries under the new version, dated today
   - installs, builds and tests
   - stages the release on npm
   - commits `chore(release): <version>` to `main` and tags `v<version>`
   - waits for you to approve the version on npm (step 5), then creates the GitHub Release from that version's changelog section
5. Approve it on npm. Open the package's **Staged Packages** tab on npmjs.com, check the version, and click **Approve** with your two-factor code. Or run `npm stage approve <stage-id>`; the run's summary shows how to list it. The run is still going and creates the GitHub Release within a few minutes of your approval. It waits up to 30 minutes; if you approve later, it ends without failing and the run's summary prints a `gh release create` command to run yourself from a checkout of `main`.

The release is live only after step 5.

## Check the listing

There is nothing to submit. The pi gallery lists every npm package that carries the `pi-package` keyword, and this package already does.

1. Run `npm view @taoc/pi-mlx-models version` once you have approved the release. It shows the new version.
2. Open https://pi.dev/packages/@taoc/pi-mlx-models and check that it shows the new version. pi.dev documents no refresh time, so reload later if the old version still shows. The README links on that page go to GitHub.

## If something goes wrong

- **The run stops before staging.** Nothing was published or pushed. Fix what the message says and run it again.
- **The version is staged but the commit or tag was not pushed.** Reject the staged version with `npm stage reject <stage-id>` (or on the Staged Packages tab), then run the release again. This can happen if `main` moved while the run was in progress.
- **No GitHub Release appeared.** You approved after the 30-minute wait, so the run ended green without one. Run the `gh release create` command from the run's summary from a checkout of `main`. If the run's log shows `npm view failed` lines, npm was unreachable while it waited; the same command fixes it.
- **A GitHub Release already existed.** The run leaves it as it is and finishes green.
- **You staged a version you do not want.** Reject it the same way. Nothing is public until you approve.

## Related

- The publishing setup and the reasons for it are written down in the comments at the top of [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml).
