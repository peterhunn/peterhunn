// Vitest setup for @atelier/api tests.
//
// buildServer(db) registers route factories that call
// credentialRepo(db) at register time. Since v… (credential
// encryption commit), credentialRepo throws at construction if
// ATELIER_CREDENTIAL_KEY isn't set. Every test that calls
// buildServer needs a key. Set a deterministic one here so all
// API tests inherit it — real production sets it via secrets.
//
// Set with ||= so a test file that wants to override (or unset)
// can still do so from its own beforeAll.
process.env["ATELIER_CREDENTIAL_KEY"] ??=
  "0".repeat(63) + "1"; // 32-byte hex — test-only, MUST NOT be used in prod
