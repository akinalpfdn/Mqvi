# /release — Create a tagged release that triggers CI build

Usage: `/release v2.5.3` or `/release` (auto-increments patch version)

## Steps

1. **Determine version**: Use the provided version argument. If none given, read the current version from `package.json` and increment the patch number (e.g., `2.5.2` → `v2.5.3`).

2. **Bump version files**: Update the version in:
   - `package.json` → `"version": "X.Y.Z"`
   - `client/src/components/settings/SettingsNav.tsx` → `mqvi vX.Y.Z`

3. **Commit the version bump**: `chore: bump version to vX.Y.Z`

4. **Generate release notes**: Run `git log` from the last tag to HEAD. Group commits by type using conventional commit prefixes:
   - `feat(...)` → "### New Features"
   - `fix(...)` → "### Bug Fixes"
   - `refactor(...)` → "### Refactoring"
   - `chore(...)` → skip (don't include in notes)
   - `test(...)` → skip
   - `perf(...)` → "### Performance"
   - Other → "### Other Changes"

   Format each entry as: `- **scope**: description`

   Wrap everything under `## What's Changed`

5. **Show the release notes to the user** and ask for confirmation before proceeding.

6. **Create annotated tag**: `git tag -a vX.Y.Z -m "<release notes>"`

7. **Push**: `git push origin main && git push origin vX.Y.Z`

8. **Confirm**: Tell the user the tag was pushed and CI will build all platforms (Windows, macOS, Linux).

## Rules
- Release notes MUST be in English (public repo)
- Never include `chore:` or `test:` commits in release notes
- Never include "Co-Authored-By" lines
- If there are no feat/fix commits since last tag, warn the user and ask if they still want to release
- The tag message should NOT include the `## What's Changed` header (just the grouped content) — GitHub release UI adds its own formatting
