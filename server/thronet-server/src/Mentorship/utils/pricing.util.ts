const toRate = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// GST hata diya gaya hai: user se sirf service ka basePrice liya jata hai.
export const GST_RATE = 0;
// Platform commission (mentor ke hisse se katti hai, user ke total mein add nahi hoti)
export const PLATFORM_FEE_RATE = toRate(process.env.MENTORSHIP_PLATFORM_FEE_RATE, 0.2);
export const PACKAGE_BASE_PRICE = toRate(process.env.MENTORSHIP_PACKAGE_BASE_PRICE, 1000);

export interface ServerPricing {
  basePrice: number;
  platformFee: number;
  gst: number;
  totalAmount: number;
  currency: string;
}

/** total = basePrice. platformFee = 20% (platform ka hissa), baaki 80% mentor ka. */
export function computePricingFromBase(basePrice: unknown): ServerPricing {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const platformFee = Math.round(base * PLATFORM_FEE_RATE);
  return { basePrice: base, platformFee, gst: 0, totalAmount: base, currency: 'INR' };
}

export const toPaise = (rupees: number): number => Math.round(rupees * 100);