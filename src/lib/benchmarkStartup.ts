const DEFAULT_SAMPLE_SIZE = 20;
const MIN_SAMPLE_SIZE = 1;
const MAX_SAMPLE_SIZE = 1000;

export interface BenchmarkSampleInitializerDependencies {
  getTotalProjects: () => Promise<number>;
  seedSamples: (sampleSize: number) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

function boundSampleSize(totalProjects: number): number {
  if (!Number.isFinite(totalProjects)) {
    throw new Error("Project count must be a finite number");
  }

  return Math.min(MAX_SAMPLE_SIZE, Math.max(MIN_SAMPLE_SIZE, Math.trunc(totalProjects)));
}

/**
 * Create a startup initializer that seeds benchmark samples exactly once.
 *
 * The registry project count determines the sample size when available. A
 * bounded default keeps startup useful when the registry cannot be reached.
 */
export function createBenchmarkSampleInitializer({
  getTotalProjects,
  seedSamples,
  warn,
}: BenchmarkSampleInitializerDependencies): () => Promise<number> {
  let initialization: Promise<number> | undefined;

  return () => {
    if (initialization) return initialization;

    initialization = (async () => {
      let sampleSize = DEFAULT_SAMPLE_SIZE;

      try {
        sampleSize = boundSampleSize(await getTotalProjects());
      } catch (err) {
        warn("[startup] benchmark project count unavailable, using default sample size", {
          sample_size: DEFAULT_SAMPLE_SIZE,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      seedSamples(sampleSize);
      return sampleSize;
    })();

    return initialization;
  };
}
