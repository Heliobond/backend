declare module "dd-trace" {
  const ddTrace: {
    init(options?: Record<string, unknown>): void;
    default: {
      init(options?: Record<string, unknown>): void;
    };
  };
  export default ddTrace;
}

declare module "newrelic" {
  const newrelic: Record<string, unknown>;
  export default newrelic;
}
