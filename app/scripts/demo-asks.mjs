// The house rules and the two asks used by demo-day.mjs (Cinq) and workflow-baseline.mjs (the comparison).
export const RULES = [
  'Money is integer cents in code and in the database; it is formatted only for display.',
  'Every call to an outside service (email, payments) has a test for what happens when it fails.',
  'No new dependency without a one-line reason in the job\'s plan.',
];
export const ASKS = {
  maya: "We're launching the Pro plan next week. Add Stripe checkout for Pro, a billing page in settings that shows the plan and what it costs, and a receipt email after payment. Admins also need a CSV export of all bookings.",
  sam: "Support keeps hearing about double bookings and missed reminders. Fix double-booking when two people grab the same slot at the same moment, send a reminder email 24 hours before each booking (retry if the email provider fails), and rename slots to appointments across the app, since that's what customers call them.",
};

