# Flightlog: sign-in on Vercel

Anyone can view the logbook. Only you can add, change or delete flights, by
logging in as admin. The login runs on Vercel, and the database key never
reaches the browser.

## Setup, once, in this order

1. **Lock the database.** Supabase dashboard > SQL Editor > New query. Paste
   `supabase_vercel_setup.sql` and Run. Do this before step 3.
2. **Copy two values from Supabase.**
   - Project URL: the Connect button at the top of the dashboard.
   - Secret key: Settings > API Keys. Use the secret key (starts with
     `sb_secret_`) or the legacy `service_role` key. Either works. Never put
     it in the site files or share it.
3. **Add the settings in Vercel.** Your project > Settings > Environment
   Variables. Add all five, for Production and Preview:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | the project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the secret key |
   | `ADMIN_USERNAME` | the username you will log in with |
   | `ADMIN_PASSWORD` | a long password nobody else knows |
   | `SESSION_SECRET` | 40 or more random characters |

   A password manager can generate the password and the secret. Do not reuse
   the old owner code or shared secret from earlier versions.
4. **Upload the files** in this zip over your site folder, keeping the
   folders: `index.html`, `style.css`, `script.js`, `vercel.json`,
   `api/` and `lib/server.js`. Then redeploy, because new environment
   variables only apply to a new deployment.
5. **Log in** with the button at the top right. Open Data and tap Sync now.
   That uploads whatever this device has. Other devices load it
   automatically when they open the site.

`vendor/supabase.js` is no longer used. You can delete it.

## Good to know

- Changing `ADMIN_PASSWORD` or `SESSION_SECRET` logs out every session.
- The site opens offline from what the device already has. Logging in and
  syncing need a connection.
- Anyone with the link can read the logbook. That is deliberate. If you want
  it private later, say so and the read side can require login too.
- The built-in limit of 5 wrong passwords per 15 minutes works per server
  instance, so it is a speed bump, not a wall. For a real one, add a rate limit
  rule for `/api/login` under Firewall in your Vercel project.
- The GitHub keepalive keeps working after step 1. It only needs a normal
  response, and gets an empty list.
- The Supabase Auth zip from earlier (`flightlog_update.zip`) belongs to a
  different design. Do not upload it over these files. You do not need to
  create any Supabase Auth users.
