import { PerpUsageError } from "./errors.js";
import type { Decimal } from "./types.js";

/**
 * Exact decimal arithmetic on scaled `bigint` values.
 *
 * The API carries money, prices, and quantities as decimal strings precisely so
 * they survive the round trip. Parsing them into `number` silently corrupts
 * values — `0.1 + 0.2 !== 0.3`, and 18-digit integers lose their tail — so this
 * module never produces a float.
 */
interface Scaled {
  units: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?$/;

export function parse(value: Decimal, label = "value"): Scaled {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new PerpUsageError(`${label} is not a plain decimal string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const digits = negative ? trimmed.slice(1) : trimmed;
  const dot = digits.indexOf(".");
  const scale = dot === -1 ? 0 : digits.length - dot - 1;
  const units = BigInt(dot === -1 ? digits : digits.slice(0, dot) + digits.slice(dot + 1));
  return { units: negative ? -units : units, scale };
}

export function format({ units, scale }: Scaled): Decimal {
  if (scale === 0) return units.toString();
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(digits) ? `-${body}` : body;
}

const rescale = (value: Scaled, scale: number): Scaled => ({
  units: value.units * 10n ** BigInt(scale - value.scale),
  scale,
});

const align = (a: Scaled, b: Scaled): [Scaled, Scaled, number] => {
  const scale = Math.max(a.scale, b.scale);
  return [rescale(a, scale), rescale(b, scale), scale];
};

/** `-1`, `0`, or `1`. */
export function compare(a: Decimal, b: Decimal): number {
  const [left, right] = align(parse(a, "a"), parse(b, "b"));
  if (left.units < right.units) return -1;
  return left.units > right.units ? 1 : 0;
}

export const isZero = (value: Decimal): boolean => parse(value).units === 0n;
export const isNegative = (value: Decimal): boolean => parse(value).units < 0n;
export const isPositive = (value: Decimal): boolean => parse(value).units > 0n;

export function multiply(a: Decimal, b: Decimal): Decimal {
  const left = parse(a, "a");
  const right = parse(b, "b");
  return format({ units: left.units * right.units, scale: left.scale + right.scale });
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [left, right, scale] = align(parse(a, "a"), parse(b, "b"));
  return format({ units: left.units + right.units, scale });
}

export function subtract(a: Decimal, b: Decimal): Decimal {
  const [left, right, scale] = align(parse(a, "a"), parse(b, "b"));
  return format({ units: left.units - right.units, scale });
}

export const negate = (value: Decimal): Decimal => {
  const parsed = parse(value);
  return format({ units: -parsed.units, scale: parsed.scale });
};

export const abs = (value: Decimal): Decimal => {
  const parsed = parse(value);
  return format({ units: parsed.units < 0n ? -parsed.units : parsed.units, scale: parsed.scale });
};

/**
 * How to resolve a value that falls between two multiples.
 *
 * `down` and `up` are relative to zero, not to the number line, so a short
 * position rounded `down` also shrinks.
 */
export type RoundingMode = "down" | "up" | "nearest";

/**
 * Snaps `value` to a multiple of `multiple`.
 *
 * Use it before sending a quantity or price: venues reject anything not aligned
 * to `quantity_step` or `price_tick`, and `down` is the safe default because it
 * never rounds an order up into more risk than intended.
 */
export function roundToMultiple(
  value: Decimal,
  multiple: Decimal,
  mode: RoundingMode = "down",
): Decimal {
  const [left, right, scale] = align(parse(value, "value"), parse(multiple, "multiple"));
  if (right.units === 0n) {
    throw new PerpUsageError("multiple must be non-zero");
  }

  const step = right.units < 0n ? -right.units : right.units;
  const negative = left.units < 0n;
  const magnitude = negative ? -left.units : left.units;

  let quotient = magnitude / step;
  const remainder = magnitude % step;
  if (remainder !== 0n) {
    if (mode === "up") quotient += 1n;
    else if (mode === "nearest" && remainder * 2n >= step) quotient += 1n;
  }

  const units = quotient * step;
  return format({ units: negative ? -units : units, scale });
}

/** Clamps to `[minimum, maximum]`; either bound may be omitted. */
export function clamp(
  value: Decimal,
  bounds: { minimum?: Decimal | undefined; maximum?: Decimal | undefined },
): Decimal {
  let result = value;
  if (bounds.minimum !== undefined && compare(result, bounds.minimum) < 0) result = bounds.minimum;
  if (bounds.maximum !== undefined && compare(result, bounds.maximum) > 0) result = bounds.maximum;
  return result;
}
