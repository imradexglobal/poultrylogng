// Centralized Unit Conversion Utilities
// Standardized across Nigerian poultry farm operations:
// - Default crate capacity: 30 eggs
// - Feed standard: 1 bag = 25 kg = 25,000 g
// - Database normalization:
//   - All egg quantities stored as individual pieces (integers)
//   - All feed quantities stored as grams (integers)

export const DEFAULT_CRATE_CAPACITY = 30;
export const GRAMS_PER_KG = 1000;
export const KG_PER_BAG = 25;
export const GRAMS_PER_BAG = 25000;

// ==================== EGG CONVERSIONS ====================

/**
 * Converts crates and extra individual pieces into total egg pieces.
 * Formula: Total pieces = (Crates * crateCapacity) + Extra pieces.
 */
export function cratesAndPiecesToTotalEggs(
  crates: number | string,
  extraPieces: number | string = 0,
  crateCapacity: number = DEFAULT_CRATE_CAPACITY
): number {
  const c = Math.max(0, Math.floor(Number(crates) || 0));
  const p = Math.max(0, Math.floor(Number(extraPieces) || 0));
  const cap = Math.max(1, Math.floor(Number(crateCapacity) || DEFAULT_CRATE_CAPACITY));
  return c * cap + p;
}

/**
 * Converts stored individual egg pieces into full crates and remaining pieces for UI display.
 */
export function totalEggsToCratesAndPieces(
  totalPieces: number | string,
  crateCapacity: number = DEFAULT_CRATE_CAPACITY
): { crates: number; pieces: number; display: string; shortDisplay: string } {
  const tot = Math.max(0, Math.floor(Number(totalPieces) || 0));
  const cap = Math.max(1, Math.floor(Number(crateCapacity) || DEFAULT_CRATE_CAPACITY));
  const crates = Math.floor(tot / cap);
  const pieces = tot % cap;

  let display: string;
  let shortDisplay: string;

  if (crates === 0 && pieces === 0) {
    display = '0 pieces';
    shortDisplay = '0 pcs';
  } else if (crates === 0) {
    display = `${pieces.toLocaleString()} piece${pieces !== 1 ? 's' : ''}`;
    shortDisplay = `${pieces} pcs`;
  } else if (pieces === 0) {
    display = `${crates.toLocaleString()} full crate${crates !== 1 ? 's' : ''}`;
    shortDisplay = `${crates} cr`;
  } else {
    display = `${crates.toLocaleString()} crate${crates !== 1 ? 's' : ''} + ${pieces.toLocaleString()} piece${pieces !== 1 ? 's' : ''}`;
    shortDisplay = `${crates} cr + ${pieces} pcs`;
  }

  return { crates, pieces, display, shortDisplay };
}

/**
 * Calculates good/sellable eggs given total collected pieces, cracked, and damaged eggs.
 * Cracked and damaged eggs are tracked separately and not added twice.
 * Good eggs = Total collected - Cracked - Damaged.
 */
export function calculateGoodEggs(
  totalPieces: number | string,
  crackedPieces: number | string = 0,
  damagedPieces: number | string = 0
): number {
  const total = Math.max(0, Math.floor(Number(totalPieces) || 0));
  const cracked = Math.max(0, Math.floor(Number(crackedPieces) || 0));
  const damaged = Math.max(0, Math.floor(Number(damagedPieces) || 0));
  return Math.max(0, total - cracked - damaged);
}

// ==================== FEED CONVERSIONS ====================

/**
 * Converts bag quantity to kilograms. (1 bag = 25kg)
 */
export function bagsToKg(bags: number | string): number {
  const b = Math.max(0, Number(bags) || 0);
  return +(b * KG_PER_BAG).toFixed(4);
}

/**
 * Converts kilograms to bags. (25kg = 1 bag)
 */
export function kgToBags(kg: number | string): number {
  const k = Math.max(0, Number(kg) || 0);
  return +(k / KG_PER_BAG).toFixed(4);
}

/**
 * Converts bags to authoritative integer grams for database storage.
 * 1 bag = 25,000 grams.
 */
export function bagsToGrams(bags: number | string): number {
  const b = Math.max(0, Number(bags) || 0);
  return Math.round(b * GRAMS_PER_BAG);
}

/**
 * Converts kilograms to authoritative integer grams for database storage.
 * 1 kg = 1,000 grams.
 */
export function kgToGrams(kg: number | string): number {
  const k = Math.max(0, Number(kg) || 0);
  return Math.round(k * GRAMS_PER_KG);
}

/**
 * Converts stored integer grams to kilograms.
 */
export function gramsToKg(grams: number | string): number {
  const g = Math.max(0, Number(grams) || 0);
  return +(g / GRAMS_PER_KG).toFixed(2);
}

/**
 * Converts stored integer grams to bags equivalent.
 */
export function gramsToBags(grams: number | string): number {
  const g = Math.max(0, Number(grams) || 0);
  return +(g / GRAMS_PER_BAG).toFixed(2);
}

/**
 * Formats stored grams into farmer-friendly UI display with primary kg and secondary bag equivalent.
 * Example: 537,500g -> { kg: 537.5, bags: 21.5, display: "537.5 kg (21.5 bags)" }
 */
export function gramsToDisplay(grams: number | string): {
  kg: number;
  bags: number;
  display: string;
  kgDisplay: string;
  bagsDisplay: string;
} {
  const g = Math.max(0, Number(grams) || 0);
  const kg = +(g / GRAMS_PER_KG).toFixed(2);
  const bags = +(g / GRAMS_PER_BAG).toFixed(2);

  return {
    kg,
    bags,
    display: `${kg.toLocaleString()} kg (${bags.toLocaleString()} bags)`,
    kgDisplay: `${kg.toLocaleString()} kg`,
    bagsDisplay: `${bags.toLocaleString()} bags`,
  };
}

// ==================== TIMEZONE & CURRENCY ====================

export const DEFAULT_TIMEZONE = 'Africa/Lagos';
export const DEFAULT_CURRENCY = 'NGN';
export const DEFAULT_CURRENCY_SYMBOL = '₦';

/**
 * Formats a number as Nigerian Naira currency (₦).
 */
export function formatNaira(amount: number | string): string {
  const num = Number(amount) || 0;
  return `${DEFAULT_CURRENCY_SYMBOL}${num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * Returns current date in YYYY-MM-DD for Africa/Lagos timezone.
 */
export function getLagosDate(): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Returns current time in HH:mm for Africa/Lagos timezone.
 */
export function getLagosTime(): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(new Date());
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
