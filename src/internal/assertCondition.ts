export function assertCondition(
  condition: unknown,
  message?: string,
): asserts condition {
  if (!condition) {
    throw new Error(message ? `assert failed: ${message}` : `assert failed`);
  }
}
