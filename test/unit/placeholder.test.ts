/**
 * Alpha stage — unit tests.
 * Pure logic only: no AWS calls, nothing deployed. Runs in the Alpha wave of
 * the pipeline, before anything is deployed to Beta.
 *
 * Placeholder for now — proves the Alpha step runs. Real unit tests for the
 * crawler/canary handlers and CDK construct assertions land here.
 */
console.log("Alpha unit tests: placeholder, always passes.");

test("alpha unit placeholder", () => {
  expect(true).toBe(true);
});
