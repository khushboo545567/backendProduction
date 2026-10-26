const toRate = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const GST_RATE = toRate(process.env.MENTORSHIP_GST_RATE, 0.18);
export const PLATFORM_FEE_RATE = toRate(process.env.MENTORSHIP_PLATFORM_FEE_RATE, 0.15);
export const PACKAGE_BASE_PRICE = toRate(process.env.MENTORSHIP_PACKAGE_BASE_PRICE, 1000);

export interface ServerPricing {
  basePrice: number;
  platformFee: number;
  gst: number;
  totalAmount: number;
  currency: string;
}

/**
 * Frontend jaisa hi formula: total = base + GST. platformFee mentor se katti hai,
 * mentee ke total mein add nahi hoti.
 */
export function computePricingFromBase(basePrice: unknown): ServerPricing {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const gst = Math.round(base * GST_RATE);
  const platformFee = Math.round(base * PLATFORM_FEE_RATE);
  return { basePrice: base, platformFee, gst, totalAmount: base + gst, currency: 'INR' };
}

export const toPaise = (rupees: number): number => Math.round(rupees * 100);