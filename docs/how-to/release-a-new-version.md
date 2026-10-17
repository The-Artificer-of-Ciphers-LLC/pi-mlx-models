# How to release a new version

For maintainers. A release is one manual run of the **Release** workflow, followed by your approval on npm. Nothing releases automatically, and pushing a tag publishes nothing.

## Before you start

- The change you want to release is merged to `main`, and its CI run has finished and passed. The workflow checks this and stops if it hasn't.
- Describe the change under `## Unreleased` in `CHANGELOG.md`, either in the pull request that makes it or just before you release. If you would rather not edit the file, type a one-line note in the workflow's **notes** field; it is used only when the Unreleased section is empty.

## Release

1. Open **Actions → Release → Run workflow** on GitHub, keeping the branch as `main`.
2. Choose the bump: `patch` for fixes, `minor` for new features, `major` for breaking changes.
3. Leave **dry-run** unticked for a real release. Tick it to check everything without staging, committing or tagging.
4. Run it. It takes a couple of minutes. The run:
   - checks that it is on `main` and that the ubuntu and macOS tests passed on that commit
   - bumps the version and moves the Unreleased changelog entries under the new version, dated today
   - installs, builds and tests
   - stages the release on npm
   - commits `chore(release): <version>` to `main` and tags `v<version>`
5. Approve it on npm. Open the package's **Staged Packages** tab on npmjs.com, check the version, and click **Approve** with your two-factor code. Or run `npm stage approve <stage-id>`; the run's summary shows how to list it.

The release is live only after step 5.

## If something goes wrong

- **The run stops before staging.** Nothing was published or pushed. Fix what the message says and run it again.
- **The version is staged but the commit or tag was not pushed.** Reject the staged version with `npm stage reject <stage-id>` (or on the Staged Packages tab), then run the release again. This can happen if `main` moved while the run was in progress.
- **You staged a version you do not want.** Reject it the same way. Nothing is public until you approve.

## Why it works this way

See [About layered configuration and trust](../explanation/layered-configuration-and-trust.md) for the project's approach to permission. The publishing setup itself is described in the comments at the top of [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml): npm trusted publishing with no stored token, and a trusted publisher that allows only staging, so a person always approves what goes live.
