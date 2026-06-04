---
name: cleanup-format
description: Handles code maintenance tasks: linting, cleanup of unused code, and formatting. Use when refactoring code to ensure style compliance and remove technical debt.
---

# Cleanup and Formatting

Use this workflow to maintain code quality after refactoring.

## Workflow

1. **Format with Prettier:**
   `npx prettier --write src/`

2. **Fix Linting:**
   `npx eslint --fix src/`

3. **Verify with Tests:**
   `npm test`
