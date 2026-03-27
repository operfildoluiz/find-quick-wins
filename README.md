# FindQuickWins

A CLI tool that analyzes any public GitHub repository and surfaces **quick-win contribution opportunities** — tasks that can be completed quickly.

## Quick Start

After setting up your .env, run:

```bash
npm run start https://github.com/expressjs/express
```

## Example Output

```
$ npm run start https://github.com/expressjs/express

  🔍 OSS Quick Wins Finder

  ✔ Repo found: expressjs/express (64,929 ⭐)
  ✔ Fetched 48 open issues, 5 languages, README: found
  ✔ Analysis complete — 8 opportunities identified.

════════════════════════════════════════════════════════════
  📦 expressjs/express
  Fast, unopinionated, minimalist web framework for node.
  ⭐ 64,929 stars  🍴 13,401 forks  💬 48 open issues fetched

  📊 REPO ASSESSMENT
  ────────────────────────────────────────────────────────
  Express has solid core documentation but thin inline code
  comments and sparse JSDoc coverage across utility files...

  🎯 QUICK WIN OPPORTUNITIES
  ────────────────────────────────────────────────────────

  #1  📝  Expand middleware usage examples   DOCUMENTATION  [XS (< 1hr)]
  ...
```

## Prerequisites

- **Node.js 18+**
- A **DeepSeek API key** — get one free at [platform.deepseek.com](https://platform.deepseek.com/api_keys)
- A **GitHub personal access token** _(optional, but recommended)_ — create one at [github.com/settings/tokens](https://github.com/settings/tokens) with no special scopes needed for public repos. Without it, GitHub limits you to 60 API requests/hour per IP.

## Installation

```bash
# Clone or download the project, then install dependencies
npm install
```

## Configuration

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```env
DEEPSEEK_API_KEY=sk-your_key_here   # required
GITHUB_TOKEN=ghp_your_token_here    # optional but recommended
```

## Usage

```bash
npx find-quick-wins <github-url>
```

All of these input formats are accepted:

```bash
npx find-quick-wins https://github.com/expressjs/express
npx find-quick-wins http://github.com/facebook/react
npx find-quick-wins github.com/vercel/next.js
npx find-quick-wins vercel/next.js                        # shorthand
npx find-quick-wins https://github.com/owner/repo.git    # .git suffix OK
```

## Understanding the Output

### Repo Assessment

A 2–3 sentence AI-generated summary of the repository's current documentation quality and how welcoming it is to new contributors.

### Opportunity List

Between 5 and 10 ranked opportunities, each showing:

| Field             | Description                                   |
| ----------------- | --------------------------------------------- |
| **Title**         | Short, action-oriented name for the task      |
| **Type badge**    | Category of work (see table below)            |
| **Effort**        | Estimated time to complete                    |
| **Description**   | What needs doing and why                      |
| **Why quick win** | Why this task is a good quick win             |
| **Issue link**    | Link to a related GitHub issue, if one exists |

### Type Badges

| Icon | Type                | Examples                            |
| ---- | ------------------- | ----------------------------------- |
| 📝   | `documentation`     | Improve README, add API docs        |
| 🧪   | `tests`             | Unit tests for utility functions    |
| 💬   | `code-comments`     | JSDoc, inline comments, docstrings  |
| ✏️   | `typo-fix`          | Spelling, grammar, copy corrections |
| 📖   | `examples`          | Usage examples, code snippets       |
| 🔧   | `linting`           | Formatting, style, lint rule fixes  |
| 📦   | `dependency-update` | Safe, well-documented version bumps |
| ⚙️   | `ci-cd`             | GitHub Actions, badges, workflows   |
| 🔍   | `other`             | Anything that doesn't fit above     |

### Effort Labels

| Label        | Meaning                                    |
| ------------ | ------------------------------------------ |
| `XS (< 1hr)` | A focused PR you can open in under an hour |
| `S (1-3hrs)` | A small but complete piece of work         |
| `M (3-8hrs)` | About half a day's effort                  |

## How It Works

```
GitHub URL
    │
    ▼
Parse owner/repo
    │
    ▼
GitHub API ──► Repo metadata (stars, language, license, topics)
            ──► Open issues (up to 50, excluding PRs)
            ──► Language breakdown
            ──► README content (first 2,000 chars)
    │
    ▼
DeepSeek API
  Prompt includes all of the above context and asks for
  a JSON list of quick-win opportunities ranked by priority
    │
    ▼
Formatted CLI output
```

## Troubleshooting

| Error                            | Fix                                                    |
| -------------------------------- | ------------------------------------------------------ |
| `DEEPSEEK_API_KEY is not set`    | Add your key to `.env`                                 |
| `Repository not found`           | Check the URL; make sure the repo is public            |
| `GitHub API rate limit exceeded` | Add `GITHUB_TOKEN` to `.env`                           |
| `DeepSeek authentication failed` | Verify your key at platform.deepseek.com               |
| `Could not parse JSON`           | Transient model output issue — just re-run the command |
| Timeout on DeepSeek call         | Network issue or high load — retry after a moment      |

## Project Structure

```
find-quick-wins/
├── index.js          # Main CLI script (single-file MVP)
├── package.json
├── .env.example      # Environment variable template
└── README.md
```

## License

MIT
