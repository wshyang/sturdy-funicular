// Organisation-dimension shared constants — addendum-109 (test-first
// contract), revised 2026-08-05.
//
// NO GATING. Owner direction 2026-08-05: "we generate test cases for our new
// behaviour that we know will fail now then we build towards that." The
// org-dimension suites run LIVE on every backend/e2e pass and are RED by
// design until the implementation lands (TDD). The ORG_PHASE phase-gate
// constant from addendum-109's first revision is retired; pre-existing
// suites stay byte-identical and green — only the new-behavior tests fail.
//
// The one dimension-default organisation. Owner direction 2026-08-04: a
// single "Default" org — fixture users of BOTH affiliations, both clusters,
// teams and systems attach to it; kind-match scoping is not exercised in the
// current regiment. Scope (same direction): registry + Default-org
// membership — organisations CRUD, EVERY fixture user, cluster, team (via
// cluster) and system (via agency cluster) hangs off it;
// approval/invite-time assignment; cluster org move guard. NO
// cross-organisation-access cases, NO global-access cases, NO kind-match
// scoping cases in the current regiment (phases 2–3 deferred, not staged).
export const DEFAULT_ORG_NAME = "Default";
export const DEFAULT_ORG_SHORT_CODE = "DEF";
