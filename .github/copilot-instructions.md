# Backend Engineering Rules

## Architecture & Code Structure

- Keep everything **loosely coupled** and **modular** whenever possible.
- Follow:
  - **Separation of Concerns (SoC)**
  - **Single Responsibility Principle (SRP)**
- Controllers should remain **thin**.
- Never place business logic inside controllers.
- All business logic must live inside dedicated **service layers**.

### Structure code for:

- Maintainability
- Scalability
- Testability
- Readability

---

## Development Approach

Before modifying anything:

1. Observe the existing architecture
2. Understand the current flow
3. Analyze dependencies
4. Identify possible side effects

### Rules

- Avoid making assumptions.
- If requirements are unclear:
  - ask questions first
  - avoid guessing
  - avoid creating technical debt disguised as confidence

Classic industry tradition:  
_"Ship confusion fast and call it agile."_

---

## Communication & Clarification

- Ask as many clarification questions as necessary.
- Continue refining understanding until at least **90% confidence** in requirements and expected behavior is achieved.
- Recommend best practices proactively when relevant.

---

## Code Quality Standards

### Prefer

- Reusable services
- Composable modules
- Dependency injection
- Interface-driven design
- Clean abstractions

### Avoid

- Tightly coupled logic
- God classes
- Duplicated logic
- Fat controllers
- Hidden side effects

---

## Core Principle

Every module, class, and function should:

- Have one clear responsibility
- Be easy to replace
- Be easy to test
- Be easy to extend
- Avoid breaking unrelated parts of the system