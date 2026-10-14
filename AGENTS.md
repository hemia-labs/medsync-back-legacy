# Backend Repo Rules

This repo is one of the git roots inside `F:\HemiaAssistantGlobal`.

## Repo Identity

- Path: `F:\HemiaAssistantGlobal\hemia-assistance-back-legacy`.
- Remote: `https://github.com/hemia-labs/medsync-back-legacy.git`.
- The workspace root above this repo is not a git repository.
- Also follow the workspace rules in `..\AGENTS.md` when available.

## Search

- Use `rg`.
- Exclude `node_modules`, `dist`, `build`, `coverage`, logs, and `.git` unless explicitly needed.

## Backend Practices

- Stack: Node/Express + MySQL/Sequelize.
- Read `package.json` before choosing commands.
- Use existing `src\config\env.js`, `src\config\config.js`, and DB connection patterns.
- Avoid many DB connections; use one connection and sequential queries for live DB work.
- Do not print `.env.local` values.

## Docs

- For substantial backend/auth/tenant/security/schema decisions, update the relevant roadmap under `..\docs`.
- Auth work belongs under `..\docs\auth`.
- SaaS/tenant/licensing work belongs under `..\docs\saas-platform`.
- Platform/env/dependency work belongs under `..\docs\platform-operations`.
