# Global Feedback Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make copy feedback safe and reusable across the workspace, and mount seasonal particles on every authenticated workspace page without blocking content or controls.

**Architecture:** Add a small shared feedback module that owns one body-level toast region, anchors messages to a trigger when possible, clamps them inside the viewport, and falls back to a top-center position. Move particle initialization into the shared authenticated shell path, remove the homepage-only guard, and scope the ambient canvas below workspace content with pointer events disabled.

**Tech Stack:** Vite, vanilla ES modules, CSS, Node.js built-in test runner, Codex in-app browser validation.

## Global Constraints

- Do not add a frontend dependency.
- Toasts must be transient, `aria-live` announced, non-interactive, and `pointer-events: none`.
- Particle canvas must be fixed, decorative, `pointer-events: none`, above page backgrounds, and below content, Toasts, and dialogs.
- Preserve reduced-motion behavior and the existing per-user seasonal preference storage.
- Verify all four workspace routes: `/`, `/vault.html`, `/admin.html`, `/ledger.html`.

### Task 1: Add failing regression tests for shared layers

**Files:**
- Create: `tests/global-feedback-layers.test.mjs`
- Test: `frontend/src/ui-feedback.js`, `frontend/src/seasonal-particles.js`, `frontend/src/shell.js`, `frontend/src/styles/admin-layout.css`

- [ ] **Step 1: Write tests that assert the intended shared contracts.**
  - Assert the source exposes `showToast(message, trigger)` and a body-level `appToastRegion`.
  - Assert the particle initializer is not restricted to `home-page` and is called from the shared shell path.
  - Assert the shared CSS uses `position: fixed`, `pointer-events: none`, and separate z-index values for particles and Toasts.
  - Assert every workspace entry module still imports `setWorkspaceUser` so the shared initialization path is exercised.

- [ ] **Step 2: Run the new test before production changes.**
  - Run: `node --test tests/global-feedback-layers.test.mjs`
  - Expected: FAIL because the shared feedback module and shared particle contracts do not exist yet.

### Task 2: Implement the shared Toast layer

**Files:**
- Create: `frontend/src/ui-feedback.js`
- Modify: `frontend/src/pages/vault.js`
- Modify: `frontend/src/styles/admin-layout.css`

- [ ] **Step 1: Implement `showToast(message, trigger)` with one reusable region.**
  - Create `#appToastRegion` under `document.body` once.
  - Create a transient toast with `role="status"`, `aria-live="polite"`, and an automatic 3.5-second removal.
  - If `trigger` has a visible bounding rectangle, place the toast below it, clamp left/right to a 16px viewport margin, and place it above the trigger when there is not enough room below.
  - If no usable trigger exists, center it at the top with a 16px safe-area margin.
  - Keep the region and toast non-interactive so it cannot block navigation or buttons.

- [ ] **Step 2: Route copy success and failure feedback through the shared layer.**
  - Pass the copy button as the trigger for account/password copy actions.
  - Pass the generator copy button for generated password copy.
  - Keep the existing inline secret/status text only for details that are useful inside the editor; successful copy feedback must also appear in the global Toast.

- [ ] **Step 3: Add the layer CSS.**
  - Give the Toast region `position: fixed`, full-viewport inset, `pointer-events: none`, and a z-index above navigation/content.
  - Give the Toast a readable max width, safe-area margins, dark workspace contrast, and a short enter/exit transition that is disabled for reduced motion.

- [ ] **Step 4: Run the focused tests and inspect the source diff.**
  - Run: `node --test tests/global-feedback-layers.test.mjs`
  - Expected: Toast contract assertions pass.

### Task 3: Promote seasonal particles into the shared shell

**Files:**
- Modify: `frontend/src/seasonal-particles.js`
- Modify: `frontend/src/shell.js`
- Modify: `frontend/src/pages/main.js`
- Modify: `frontend/src/styles/admin-layout.css`

- [ ] **Step 1: Remove the homepage-only mount guard.**
  - Allow initialization on `.vben-shell` pages while retaining the duplicate-canvas guard.
  - Keep the existing user-specific local/session storage keys and reduced-motion handling.
  - Change the settings helper copy from homepage-only wording to workspace-wide seasonal ambience.

- [ ] **Step 2: Initialize particles from `setWorkspaceUser`.**
  - Import `initSeasonalParticles` into `shell.js`.
  - Call it after shared appearance markup is mounted and the authenticated user is known.
  - Remove the page-specific import and call from `main.js`.

- [ ] **Step 3: Generalize the layer CSS.**
  - Apply isolation to all `.vben-shell.console-page` bodies.
  - Set the particle canvas to fixed full-viewport positioning, z-index `0`, `pointer-events: none`, and reduced opacity.
  - Set all `.console-main` content to a higher stacking level; leave the rail/backdrop and Toast above it.

- [ ] **Step 4: Run the focused tests and build.**
  - Run: `node --test tests/global-feedback-layers.test.mjs`
  - Run: `npm.cmd run check`
  - Run: `npm.cmd run build:frontend`

### Task 4: Browser verification and screenshots

**Files:**
- No committed files; screenshots remain in the browser session only.

- [ ] **Step 1: Verify the shared layer contract on each route.**
  - Visit `/`, `/vault.html`, `/admin.html`, and `/ledger.html` with the authenticated admin session.
  - For each page, confirm `#seasonalParticles` exists, has fixed positioning, `pointer-events: none`, and is visible when reduced motion is not enabled.
  - Confirm the page has meaningful content, no Vite overlay, and no relevant console errors.

- [ ] **Step 2: Exercise Toast behavior.**
  - On the Star Key Store, trigger generated-password copy.
  - Confirm `#appToastRegion` is attached to `body`, the Toast is visible near the button, its bounding box stays inside the viewport, and it does not cover the left navigation.

- [ ] **Step 3: Capture four screenshots.**
  - Capture one screenshot each for the workspace, Star Key Store, Management Hub, and Cost Ledger after the fix.
  - Report any remaining limitation, especially if the current account has no credential record to exercise the copy action.

### Task 5: Final verification

- [ ] **Step 1: Run the full available regression set.**
  - Run: `node --test tests/ledger-ui.test.mjs tests/login-flow.test.mjs tests/global-feedback-layers.test.mjs`
  - Run: `npm.cmd run check`
  - Run: `npm.cmd run build:frontend`

- [ ] **Step 2: Review changed files and confirm no credentials or screenshots were added.**
  - Run: `git status --short`
  - Run: `git diff --check`
