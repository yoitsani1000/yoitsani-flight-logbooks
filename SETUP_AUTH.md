# Flightlog: turning on sign-in

Do these once, in this order. Sign-in will not work until step 4 is done.

1. **Close sign-ups.** Supabase dashboard > Authentication > Sign In / Providers
   (or Settings). Under Email, turn off "Allow new users to sign up". Leave Email
   itself enabled. If you skip this, anyone could create an account and read your
   logbook.
2. **Create your account.** Authentication > Users > Add user > Create new user.
   Enter your email and a strong password, and tick "Auto Confirm User".
3. **Create accounts for friends** the same way if you want them to view the
   logbook. They get read-only access automatically. Give each person their own
   password so you can remove one without affecting the rest.
4. **Run `supabase_auth_setup.sql`.** SQL Editor > New query. Replace
   YOUR_EMAIL_HERE with your email first, then Run.
5. **Upload the new site files** (`index.html`, `style.css`, `script.js`) over the
   old ones. Nothing else changed in the site folder.
6. **Sign in.** Open the site and sign in with your account. If you were already
   signed in somewhere, sign out and back in once so the owner role takes effect.

## What changed for you

- The PIN keypad is gone. The old owner code, viewer code and shared secret are
  no longer in the site's code and no longer do anything.
- You can use the app offline. Your data stays on the device, and the last
  sign-in is remembered, so the site opens without a connection. Syncing needs
  a connection.
- Friends only see Dashboard, Southwest Virtual and Logbook. Log flight and Data
  are owner-only, and the database refuses their writes even if they try.
- The GitHub keepalive keeps working. It uses the anon key, which now returns an
  empty list instead of your data.
- To remove someone, delete their user under Authentication > Users.
- If you forget your password, reset it from Authentication > Users.

## Housekeeping

- The old shared secret and owner code appeared in earlier versions of the code
  and in this chat. They no longer protect anything, but do not reuse them as
  your new password.
- The anon key in `script.js` is meant to be public. With these policies it can
  no longer read or change your data on its own.
