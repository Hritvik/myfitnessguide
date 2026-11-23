# Contributing to MyFitnessGuide

## Branch Strategy

This repository uses **GitHub Flow**:
- `main` is the canonical, always-deployable branch
- All work happens on feature branches
- Changes are merged via pull requests

## How to Contribute

### 1. Create a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/your-feature-name
```

**Branch naming conventions:**
- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation only
- `test/` - Test changes only
- `refactor/` - Code refactoring

### 2. Make Your Changes

- Write code following existing patterns
- Add tests for new functionality
- Update documentation as needed

### 3. Test Locally

```bash
# Install dependencies
npm install

# Run worker tests
npm run test -w @myfitnessguide/worker

# Run web tests
npm run test -w @myfitnessguide/web

# Run e2e tests (required before deployment)
npm run test:e2e -w @myfitnessguide/web
```

### 4. Create a Pull Request

```bash
git push origin feat/your-feature-name
```

Then visit GitHub to create a PR.

**PR Requirements:**
- Title should be descriptive (e.g., "feat: add meal planning tools")
- Description should explain what and why
- Link to relevant issues/tickets
- All tests must pass
- At least one approval required (for now, self-approval is acceptable)

### 5. Merge and Deploy

After approval:
- Merge the PR via GitHub (merge commit, no squash for now)
- The deploy gate will run automatically
- If e2e tests pass, deployment proceeds

## Pre-Deployment Checklist

Before deployment, ensure:
- [ ] You are on `main` (`git branch --show-current`)
- [ ] All tests pass locally
- [ ] E2E tests pass (run `npm run test:e2e -w @myfitnessguide/web`)
- [ ] Working tree is clean (`git status`)
- [ ] Database migrations are reviewed
- [ ] Breaking changes are documented

## Deployment

Deployment is handled via the deploy gate:
```bash
npm run deploy -w @myfitnessguide/worker
```

The deploy gate:
1. Refuses unless the checkout is on `main`
2. Builds the web app
3. Checks the e2e stamp (a clean tree tested at this commit; `E2E_GATE_OVERRIDE="<reason>"` stands in for this one check only)
4. Deploys to Cloudflare Workers
5. Verifies deployment

## Common Mistakes to Avoid

### ❌ Don't branch from stale branches
```bash
# Wrong: branching from an old feature branch
git checkout feat/old-feature
git checkout -b feat/new-feature

# Correct: always branch from main
git checkout main
git pull origin main
git checkout -b feat/new-feature
```

### ❌ Don't commit directly to main
All changes must go through PRs.

### ❌ Don't leave long-lived branches
Delete branches after merging:
```bash
git branch -d feat/your-feature-name
git push origin --delete feat/your-feature-name
```

### ❌ Don't skip tests
Always run tests before pushing.

## Branch Cleanup

Periodically clean up stale branches:
```bash
# List merged branches
git branch --merged main

# Delete merged branches locally
git branch -d branch-name

# Delete from remote
git push origin --delete branch-name
```

## MCP Tools

MCP tools are defined in `app/worker/src/tools/`. When adding new tools:
1. Add to the appropriate file (e.g., `nutrition.ts`, `health.ts`)
2. Export in the `TOOLS` array in `tools/index.ts`
3. Add tests in `app/worker/test/`
4. Test via MCP: `https://myfitnessguide.hritvikdinkar.workers.dev/mcp`

## Database Migrations

Migrations are in `app/worker/migrations/`. Naming convention: `####_description.sql`.

When adding a migration:
1. Create the SQL file
2. Add a test in `app/worker/test/migration-####.test.ts`
3. Review data safety (DROP, ALTER, etc.)
4. Test on a copy of production data if possible

## Getting Help

- Check `CONTEXT.md` for the domain glossary and `docs/design/PRODUCT.md` for
  product truths
- Check the `DECISIONS.md` file in each app for technical decisions
- Check existing test files for patterns
- Open a GitHub discussion

## Code Style

- Follow existing patterns in the codebase
- Use TypeScript for type safety
- Keep functions focused and small
- Add comments for non-obvious logic
- Don't add/remove comments unless explicitly asked

## Security

- Never commit secrets or API keys
- Never expose user data in logs
- Follow Cloudflare Access patterns for authentication
- Review privacy implications of new features

## Troubleshooting

### Deployment fails with "no e2e stamp"
Run e2e tests on a clean tree:
```bash
git status  # ensure clean
npm run test:e2e -w @myfitnessguide/web
```

### Deployment refused: "the checkout is on …, not main"
Deploys run from `main` only. Merge your branch first, then:
```bash
git checkout main
git pull origin main
npm run deploy -w @myfitnessguide/worker
```

### MCP tools not showing
Check:
1. Tool is exported in `tools/index.ts`
2. Tool is defined correctly
3. Worker is deployed
4. MCP client is connected to correct URL

### Package resolution errors
```bash
npm install
```

If that fails, try:
```bash
rm -rf node_modules package-lock.json
npm install
```
