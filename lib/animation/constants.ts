/**
 * Shared animation constants — extracted so the same easing curve isn't
 * duplicated across half a dozen components. Add new shared timings /
 * curves here.
 */

/**
 * "Strong ease-out" curve used by virtually every entry animation in
 * the hub: fast initial acceleration, long quiet settle. Matches the
 * feel of a dropped object coming to rest.
 *
 * Cubic-bezier: [0.075, 0.82, 0.165, 1]
 */
export const EASE_OUT: [number, number, number, number] = [
  0.075, 0.82, 0.165, 1,
];

/**
 * Alias for components that previously imported a local `EASE`. Keeps
 * call sites short.
 */
export const EASE = EASE_OUT;
