/** Narrows away an optional in a test without a `!`.
 *
 *  A `!` turns a missing value into "cannot read property of undefined" somewhere inside the code
 *  under test, which reads like a product bug even when the fixture is what drifted. This fails at
 *  the lookup and names what was absent. The throw is the assertion — the test fails on it. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}
