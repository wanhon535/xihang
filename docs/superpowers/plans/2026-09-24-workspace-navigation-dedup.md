# Workspace Navigation Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the approved workspace navigation while hiding the repeated page-level title block on internal pages.

**Architecture:** Keep the existing sidebar, workspace header, and `.workspace-tabs` navigation. Restore their shared synchronization in `frontend/src/shell.js`, then hide only `.console-topbar.page-heading` through shared CSS so the page-specific title is not rendered twice. Establish an explicit ambient-layer stack where the particle canvas sits above the page background but below direct content, navigation chrome, dialogs, and Toasts.

**Tech Stack:** Static HTML, ES modules, scoped CSS, Node.js built-in test runner, Vite.

## Global Constraints

- Do not change business data, APIs, authentication, Toast, or seasonal particle behavior.
- Keep the existing sidebar collapse, mobile drawer, Escape handling, and active-page highlighting.
- The workspace breadcrumb and tabs remain visible.
- The internal page `.console-topbar.page-heading` is hidden; the workbench hero remains visible.
- Layer order is background < particles < page content < header/sidebar < Toast/dialog.
- Particle canvas remains `pointer-events:none`.
- Keep the requested local host `http://127.0.0.1:2223` for rendered QA.

---

### Task 1: Add a regression test for the single-navigation shell

**Files:**
- Modify: `tests/global-feedback-layers.test.mjs`
- Test: `tests/global-feedback-layers.test.mjs`

**Interfaces:**
- Consumes: shared shell source and shared layout CSS.
- Produces: source-level assertions that preserve `.workspace-tabs` and require the repeated page heading to be hidden.

- [ ] **Step 1: Write the failing test**

Add this test after the existing shell tests:

```js
test('workspace shell keeps one page navigation and one page-title source', () => {
  const shell = read('frontend/src/shell.js');
  const css = read('frontend/src/styles/admin-layout.css');
  assert.match(shell, /className = 'workspace-tabs'/);
  assert.match(shell, /body\.prepend\(header, tabs\)/);
  assert.match(css, /body\.vben-shell\.console-page \.console-topbar\.page-heading\s*\{[^}]*display:none/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/global-feedback-layers.test.mjs`

Expected: FAIL because the current shell no longer creates `.workspace-tabs` and the current layout has no shared rule hiding the repeated page heading.

### Task 2: Remove the duplicate shell navigation and tighten layout spacing

**Files:**
- Modify: `frontend/src/shell.js`
- Modify: `frontend/src/styles/admin-layout.css`

**Interfaces:**
- Consumes: the existing page-specific `h1` and the existing `.side-nav` markup.
- Produces: a shared header with product/utility controls only, plus a single sidebar navigation.

- [ ] **Step 1: Simplify the shared header construction**

In `frontend/src/shell.js`, keep the existing `.workspace-header`, `.workspace-breadcrumb`, `.current-page`, and `.workspace-tabs` creation. The header and tab labels must continue to follow the page `h1` through the existing `MutationObserver`.

- [ ] **Step 2: Keep utility controls in the header**

Leave the existing `.workspace-tools` behavior intact: move `.console-user`/`#logoutBtn` into it and prepend the appearance button on non-home pages. Keep `body.prepend(header)` and all navigation toggle logic unchanged.

- [ ] **Step 3: Restore tab bookkeeping from the authenticated user setter**

In `setWorkspaceUser(user)`, keep the sidebar page list and admin-only visibility logic, query `.workspace-tabs`, and retain the tab existence/insertion loops so the top tabs reflect the same allowed pages. Leave particle initialization at the end of the function.

- [ ] **Step 4: Hide only the repeated page heading**

Restore the `.workspace-tabs` rules and the original `.console-main` spacing of `padding:116px 24px 24px` on desktop and `padding:110px 14px 20px` on mobile. Add `body.vben-shell.console-page .console-topbar.page-heading { display:none }`; do not hide the workspace header or tabs. Keep the header fixed at `height:56px` and the sidebar z-index unchanged.

- [ ] **Step 5: Put seasonal particles in the ambient layer**

In `frontend/src/styles/admin-layout.css`, change the particle canvas to `z-index:2`, remove the stacking `z-index:1` from `.console-main` by setting it to `z-index:auto`, and add `.vben-shell.console-page .console-main > * { position:relative; z-index:3 }`. Keep the canvas fixed and `pointer-events:none`; retain header `z-index:40`, sidebar `z-index:50`, and Toast `z-index:1000`.

- [ ] **Step 6: Run the focused regression test**

Run: `node --test tests/global-feedback-layers.test.mjs`

Expected: PASS with all tests passing.

### Task 3: Run static checks and rendered visual QA

**Files:**
- Inspect: `frontend/index.html`
- Inspect: `frontend/vault.html`
- Inspect: `frontend/admin.html`
- Inspect: `frontend/ledger.html`

**Interfaces:**
- Consumes: the updated shared shell and CSS.
- Produces: evidence that all four pages have one navigation and one visible page title without runtime errors.

- [ ] **Step 1: Run project checks**

Run: `npm.cmd run check`

Expected: exit code 0.

- [ ] **Step 2: Build the frontend**

Run: `npm.cmd run build:frontend`

Expected: exit code 0 and Vite writes the frontend bundle.

- [ ] **Step 3: Verify each page over HTTP**

Run a local HTTP check for `http://127.0.0.1:2223/`, `/vault.html`, `/admin.html`, and `/ledger.html`; each must return HTTP 200.

- [ ] **Step 4: Capture desktop screenshots**

Reload each route in the existing local browser session. Confirm the sidebar is the only page navigation, the top header has no repeated current-page label, and the main `h1` remains visible. Save screenshots outside the repository for the final report.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the intended shell, CSS, test, and documentation changes are present in this task.
