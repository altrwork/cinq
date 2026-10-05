// What each plan allows. Pro is unlimited; Free has a monthly booking cap.
export const PLANS = {
  free: { name: 'Free', priceCents: 0, bookingsPerMonth: 20 },
  pro: { name: 'Pro', priceCents: 1200, bookingsPerMonth: Infinity },
};
export function planFor(user) { return PLANS[user?.plan] || PLANS.free; }
export function canBook(user, bookingsThisMonth) { return bookingsThisMonth < planFor(user).bookingsPerMonth; }
