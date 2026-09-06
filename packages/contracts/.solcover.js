module.exports = {
  // Test doubles are not deployed and must not inflate or deflate the real numbers.
  skipFiles: ["mocks/"],
  // json-summary is what tools/check-coverage.mjs reads to enforce the gate.
  istanbulReporter: ["html", "lcov", "text", "json-summary"],
  configureYulOptimizer: true,
};
