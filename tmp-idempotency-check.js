process.env.PROJECT_REGISTRY_CONTRACT_ID = 'test-contract';
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './iot') {
    return { getSolarData: () => ({ timestamp: Date.now(), forest_density_pct: 50, ndvi_score: 0.5 }) };
  }
  if (request === './satellite-sources') {
    return { fetchSatelliteWithFallback: async () => ({ timestamp: Date.now(), forest_density_pct: 50, ndvi_score: 0.5 }) };
  }
  if (request === './scoring') {
    return { computeScores: () => ({ credit_quality: 10, green_impact: 20 }) };
  }
  if (request === './registry') {
    return { updateImpactScore: async () => 'tx-hash-1', RpcDegradedError: class RpcDegradedError extends Error {} };
  }
  return originalLoad.apply(this, arguments);
};
(async () => {
  const { updateScoreForProject } = require('./src/lib/scoreService');
  const result = await updateScoreForProject(42);
  console.log(JSON.stringify(result));
})();
