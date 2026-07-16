// ══════════════════════════════════════════
// AI MODELS — the single source of truth for model IDs
// ══════════════════════════════════════════
//
// Why this file exists (and why it is not just in config.js):
// A retired model ID is an app-wide AI outage. config.js is the documented
// home for AI_MODEL_DEFAULT / AI_MODEL_LIGHT, but several pages CANNOT load
// config.js because they declare their own BASE_ID / PAT / TEAM /
// allBusinesses and would hit a const redeclaration error (os/systemisation
// is the main one). Those pages were each hardcoding the model ID instead.
//
// This file carries the ONLY literals, attaches them to `window` (no lexical
// const, so it can never collide with a page's own declarations), and is
// safe to load anywhere. config.js reads its constants from here.
//
// Load order: this file MUST come before js/config.js.
//
// Adding a page that needs a model ID:
//   Root level      <script src="js/ai-models.js?v=1"></script>
//   os/*            <script src="../../js/ai-models.js?v=1"></script>
// Then use window.AI_MODELS.default / window.AI_MODELS.light — never a literal.

window.AI_MODELS = Object.freeze({
    // Main model for in-app AI features (reasoning, generation, extraction).
    default: 'claude-sonnet-4-6',
    // Cheap model for light, high-volume, rule-following tasks.
    light: 'claude-haiku-4-5-20251001',
});
