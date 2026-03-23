# Contributing to mqvi

Thank you for your interest in contributing to mqvi! This guide explains how to report issues, propose features, and submit pull requests.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Reporting Issues](#reporting-issues)
- [Requesting Features](#requesting-features)
- [Pull Requests](#pull-requests)
- [Commit Messages](#commit-messages)
- [Branch Naming](#branch-naming)
- [Code Style](#code-style)
- [Development Setup](#development-setup)

---

## Code of Conduct

Be respectful, constructive, and inclusive. Harassment, discrimination, or toxic behavior will not be tolerated. We're here to build something great together.

---

## Getting Started

Before contributing, please:

1. Check [existing issues](https://github.com/akinalpfdn/Mqvi/issues) to avoid duplicates
2. Read through this guide fully
3. Set up your local development environment (see [Development Setup](#development-setup))

---

## Reporting Issues

### Bug Reports

Use the **Bug Report** issue template. A good bug report includes:

**Title format:** `[Component] Short description of the bug`

Examples:
- `[Voice] Microphone stays muted after reconnect`
- `[Chat] Mention indicator reappears after channel switch`
- `[Electron] Tray icon oversized on macOS`

**Required information:**
- **Steps to reproduce** — Numbered list, specific and minimal
- **Expected behavior** — What should happen
- **Actual behavior** — What actually happens
- **Environment** — OS, browser/Electron version, server version
- **Screenshots/Logs** — Console errors, screenshots, screen recordings

**Do NOT:**
- Submit vague reports like "voice doesn't work" — be specific
- Combine multiple bugs into one issue
- Include sensitive data (tokens, passwords, server IPs)

### Security Vulnerabilities

**Do NOT open a public issue for security vulnerabilities.** Instead, email the maintainer directly or use GitHub's private vulnerability reporting.

---

## Requesting Features

Use the **Feature Request** issue template.

**Title format:** `[Component] Short description of the feature`

Examples:
- `[Chat] Add thread/reply support`
- `[Voice] Add noise gate sensitivity slider`
- `[UI] Drag-and-drop channel reordering`

**Required information:**
- **Problem** — What problem does this solve? Why is it needed?
- **Proposed solution** — How should it work from the user's perspective?
- **Alternatives considered** — What other approaches did you think about?

**Do NOT:**
- Request features without explaining the use case
- Submit implementation details as feature requests — describe *what*, not *how*

---

## Pull Requests

### Before You Start

1. **Open an issue first** for non-trivial changes. Discuss the approach before writing code.
2. **One PR = one concern.** Don't mix features, bug fixes, and refactoring.
3. **Don't refactor and add features in the same PR.** These are separate commits, separate branches, separate PRs.

### PR Title Format

```
<type>(<scope>): <short description>
```

Examples:
- `feat(voice): add noise gate sensitivity slider`
- `fix(chat): prevent mention indicator from reappearing`
- `refactor(ws): extract event dispatcher into separate module`
- `chore(deps): upgrade livekit-server-sdk to v1.5.0`

**Rules:**
- Lowercase, imperative tense, no period at the end
- Max 72 characters
- Scope matches the affected area (voice, chat, ui, ws, auth, electron, etc.)

### PR Description

Every PR must include:

```markdown
## Summary
- What this PR does (1-3 bullet points)

## Problem
- What issue does this solve? Link the issue: Fixes #123

## Changes
- List of specific changes made

## Test Plan
- [ ] How you tested this
- [ ] Edge cases considered
- [ ] Platforms tested (web, Electron, macOS, Linux)

## Screenshots
(if UI changes — before/after)
```

### PR Checklist

Before requesting review, ensure:

- [ ] Code follows the project's existing patterns and conventions
- [ ] No hardcoded strings — all user-facing text uses i18n (`t()` keys, both EN + TR)
- [ ] No inline styles — all colors/fonts/spacing use theme tokens
- [ ] No `any` types in TypeScript
- [ ] No `console.log` in production code
- [ ] All comments and log messages are in English
- [ ] Backend: errors are wrapped with context, not swallowed
- [ ] Backend: `context.Context` is passed through I/O functions
- [ ] Tests pass locally
- [ ] No unrelated changes included

---

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <short description>

[optional body — explains WHY, not WHAT]
```

### Types

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change with no behavior change |
| `chore` | Dependencies, build, tooling |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `perf` | Performance improvement |
| `style` | Formatting, no logic change |

### Examples

```
feat(auth): add JWT refresh token rotation
fix(voice): prevent mic staying muted after SDK reconnect
refactor(ws): extract event dispatcher from hub
chore(deps): upgrade electron to v33.5.0
```

### Forbidden

```
fix stuff
update
WIP
final
asdfgh
```

---

## Branch Naming

Lowercase, hyphen-separated, max 50 characters:

```
feature/noise-gate-slider
fix/mention-indicator-persist
chore/upgrade-livekit-sdk
refactor/split-voice-service
```

**Pattern:** `<type>/<short-description>`

One branch = one concern. If your branch does two things, split it.

---

## Code Style

### Go (Backend)

- Follow existing patterns in `server/` — read before writing
- Constructor injection for all dependencies (`NewXxxService(...)`)
- Errors are wrapped with context: `fmt.Errorf("fetchUser %s: %w", id, err)`
- No global state, no `init()` side effects
- Goroutines must have visible exit conditions
- `context.Context` as first parameter for I/O functions

### TypeScript/React (Frontend)

- `strict: true` — no `any`, no `as` without comment
- Components: one file = one component
- State: Zustand stores for global, `useState` for local UI only
- Styling: Tailwind with theme tokens from `globals.css @theme` — no inline styles
- i18n: all user-facing strings via `t()` with both EN and TR translations

### General

- All comments, logs, error messages in **English**
- Turkish is only allowed in i18n locale files (`locales/tr/*.json`)
- Minimum font size: 13px — never use smaller text anywhere
- No commented-out code in commits

---

## Development Setup

### Prerequisites

- **Go** 1.22+
- **Node.js** 22+
- **Git**
- **LiveKit Server** — required for voice/video functionality

### LiveKit (Voice/Video)

Voice and video require a running LiveKit server. Without it, the app works fine for text chat but voice channels won't connect.

**Quick local setup:**

```bash
# Download LiveKit binary
# Linux/macOS:
curl -sSL https://get.livekit.io | bash

# Or use the project's setup script:
# Linux:
sudo bash deploy/livekit-setup.sh
# Windows (PowerShell as Admin):
irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
```

If you're setting up manually, create a `livekit.yaml`:

```yaml
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  devkey: secret
```

Start LiveKit:

```bash
livekit-server --config livekit.yaml --dev
```

Then set these in your server's `.env`:

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Backend

```bash
cd server
cp ../deploy/.env.example .env   # copy and edit .env
go mod download
go run .
```

The server starts on `http://localhost:9090`.

### Frontend

```bash
cd client
npm install
npm run dev
```

Vite dev server starts on `http://localhost:5173` with API proxy to `:9090`.

### Electron (Desktop)

```bash
npm install          # root package.json
npm run electron:dev
```

### Database

SQLite — no external database setup needed. Migrations run automatically on server start.

---

## Questions?

If something is unclear, open a [Discussion](https://github.com/akinalpfdn/Mqvi/discussions) or ask in the issue before starting work. We'd rather help you get it right than review a PR that needs major changes.
