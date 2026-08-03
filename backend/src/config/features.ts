// Server-side feature flags.
//
// Disciplinary-rule AI legal analysis — the Rule XI interpretive lens, complaint
// rule-violation analysis, Rule 1.15 trust-record flags, and deficiency-letter
// drafting — is DISABLED. ODC is not permitted to use AI for that kind of legal
// analysis during testing. This flag gates the analysis at the source so the model
// is never even asked to perform it (not merely hidden in the UI).
//
// Mirror of the frontend `RULE_ANALYSIS_ENABLED` flag in frontend/index.html.
// Set the env var RULE_ANALYSIS_ENABLED=true (and flip the frontend flag) to
// re-enable the capability across both tiers.
export const RULE_ANALYSIS_ENABLED = process.env.RULE_ANALYSIS_ENABLED === "true";
