/**
 * Beta post-deploy smoke test — placeholder.
 * Proves out the pipeline plumbing (source checkout, Node runtime, post-step
 * gating) before the real check lands: invoking CrawlerFunction-Beta and
 * CanaryFunction-Beta via @aws-sdk/client-lambda and failing on a bad response.
 */
console.log("Beta smoke test: placeholder, always passes.");
