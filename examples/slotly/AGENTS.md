# Slotly conventions

How this codebase is put together. Reviewers hold every change to it.

- **Routes do HTTP, nothing else.** Files in `src/routes/` and `src/auth/routes.js` read the request and pick a response.
  They never write SQL: database access lives in the domain modules (`src/bookings.js`, `src/slots.js`, `src/users.js`)
  through `src/db.js`.
- **Money is integer cents.** Format it only for display, with `src/money.js`.
- **Times are UTC milliseconds.** Format them only for display, with `src/time.js`, in the viewer's timezone.
- **Email goes through the mailer** (`createMailer` in `src/email.js`); message text lives in its `templates`.
- **Tests use `test/helpers.js`** (`testDb`, `fakeMail`, `seed`) and never touch the network.
