export function inlineJsonModule(options: {
  header: readonly string[];
  exportName: string;
  entries: Iterable<[string, unknown]>;
}): string;
