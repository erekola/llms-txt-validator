// Test-only fixture, not shipped (test/ is not in package.json "files"). Stubs global fetch
// so a CLI subprocess test can exercise the V-05 network-error JSON shape without a real
// DNS failure, which would also make the test as slow as the fetch's own 8 second timeout.
// Loaded with `node --import` ahead of bin/cli.mjs.
globalThis.fetch = async () => {
  const cause = new Error("getaddrinfo EAI_AGAIN example-mocked-network-error.test");
  cause.code = "EAI_AGAIN";
  const err = new TypeError("fetch failed");
  err.cause = cause;
  throw err;
};
