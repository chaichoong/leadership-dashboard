# Build Feature: verification (Phase 6a to 6d)

Moved from SKILL.md on 21 Sep 2026, word for word. Read once the health bar is wired (Phase 5).

### 6a. Dev server test

Start the preview server and test the golden path:
1. Load the page — does it render without console errors?
2. Does data appear (or correct empty state)?
3. Click every action button — do they work?
4. Check the health bar — does it render, do checks pass?
5. Click Refresh in the health bar — does it re-sync?
6. Check sidebar badge — does the count match?

### 6b. Edge case test

- Empty data (no records match)
- Large data (100+ records — does pagination work?)
- Network error (temporarily wrong PAT — does it show an error toast, not crash?)
- Rapid clicks (double-submit prevention)
- Tab switch and return (does state persist correctly?)

### 6c. Visual check

- Screenshot the feature at desktop width
- Check it at 1024px width (tablet)
- Verify colours match the design system (no rogue greys or blues)

### 6d. Screenshot walkthrough evidence (MANDATORY)

Before declaring the feature done, produce screenshot evidence of a full walkthrough. This proves the feature works and gives Kevin a visual record of what was built. Use the preview tools to capture each screenshot.

**Required screenshots (minimum):**

1. **Initial load state** — the feature as it appears when first opened (or empty state if no data)
2. **Data populated** — the feature with real or representative data loaded
3. **Primary interaction** — the main action being performed (e.g. opening a modal, expanding a card, clicking a button)
4. **Action result** — the outcome of the primary action (e.g. record created, status changed, form submitted)
5. **Secondary views** — if the feature has tabs, filters, or alternative views, screenshot at least one
6. **Tablet width** — the feature at 1024px width to verify responsive behaviour

Present all screenshots to Kevin with a brief caption for each. This is not optional. The feature is not done until the walkthrough is shared.
