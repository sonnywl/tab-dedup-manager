---
name: feature-lifecycle-management
description: Manage feature lifecycle with consistent steps: 1. implement feature, 2. write tests, 3. verify and update spec. Use when implementing new features or major changes to ensure architectural integrity and test coverage.
---

# Feature Lifecycle Management

Follow this 3-step process for every new feature or significant code change:

## 1. Implement Feature
- Focus on the implementation, following the `Clean Code Mandate` in `GEMINI.md`.
- Ensure Single Responsibility Principle (SRP) and Dependency Injection are maintained.
- Remove dead code or redundant parameters.

## 2. Write Tests
- Create or update tests before considering the feature complete.
- **Prefer Unified Simulation**: Use `test-utils.ts` to ensure consistency with browser behavior.
- Ensure test coverage for new logic, edge cases, and feature toggles.

## 3. Verify and Update Spec
- Run verification tests (e.g., `npm test`).
- Update `SPEC.md` and `GEMINI.md` (if applicable) to document new behaviors, invariants, or configurations.
- Verify that the new code complies with architectural mandates.
- Run build/linting commands to ensure structural integrity.

## Feature Toggle Management
When adding or updating configuration flags (e.g., in `GroupingConfig`):
1.  **Types**: Update `GroupingConfig` in `src/types.ts`.
2.  **Validation**: Update `validateGroupingConfig` in `src/types.ts` to ensure the new flag is validated.
3.  **App State**: Initialize the new flag in `src/App.tsx` (default state, `startSyncStore` call, and validation fallback).
4.  **Persistence**: Ensure the controller's `loadConfiguration` correctly maps the flag from the store.
5.  **Logic**: Implement the feature in `TabGroupingController.ts` and downstream services, ensuring the flag is passed and used correctly.
