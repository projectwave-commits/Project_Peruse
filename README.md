# Hellenic Prefects

Prefects look up a student on their phone and record a demerit. Admins turn those demerits into
the weekly Dress Parade and Manual Labour lists, as Word documents in the school's current format.

Runs on Node.js and SQLite. Everything is free, and there is no separate database server to install.

## Try it

Needs [Node.js](https://nodejs.org) 24 LTS.

```
npm install
npm run seed     (optional: loads made-up students and prefects)
npm start
```

Open the address it prints. Logins are in `data\initial-logins.csv`; everyone chooses their own
password the first time they log in. Delete that file once the passwords have been handed out.

## Install on the school server

1. Install Node.js 24 LTS, and clone the `prod` branch to the server (for example `C:\Project_Peruse`).
2. In that folder, run `npm install --omit=dev`.
3. Right-click PowerShell, choose Run as administrator, then run:
   `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1`
4. Give the server a fixed IP address or a DNS name, such as `http://prefects.school.local:3080`.

The script makes the app start with Windows under the low-privilege Network Service account, limits the
`data` folder to that account and administrators, and allows access from the server's local subnet only.
If phones use a different subnet (a separate Wi-Fi network), widen the firewall rule to cover it.

### Run it behind nginx

Use this when the server already hosts another site, so the app appears at an address like
`http://10.2.0.190/prefect/`. The steps above still apply, except that no port is opened to phones.

1. Copy `.env.example` to `.env`, and set `HOST=127.0.0.1` and `COOKIE_PATH=/prefect/`. Do this before
   running the install script. If the port is not 3080, change it in `scripts/nginx-prefect.conf` as well.
2. Run the install script as above, then, as administrator:
   `powershell -ExecutionPolicy Bypass -File scripts\setup-nginx.ps1`

That script backs up `nginx.conf`, adds the route, and applies it only if `nginx -t` passes. If nginx runs as
a Windows service, the other site is down for a few seconds while the service restarts. The route accepts school addresses (`10.x.x.x`) only. If the same nginx is also shared
through a tunnel such as ngrok, the tunnel gets 403 at this path, so the records stay on the school network.
Check that from outside after any change. If the server's address changes, update it in the config.

If nginx serves HTTPS, also set `SECURE_COOKIES=1` in `.env`, and restart the app.

To move to another address, change `/prefect` in `scripts/nginx-prefect.conf` and `COOKIE_PATH` in `.env`,
run the script again, and restart the app. Everyone logs in once more, and old bookmarks stop working.

### Releasing a new version

`dev` is where changes are made and tested. `prod` is what the server runs, and only receives approved work.

```
git push origin dev:prod          (from the development PC, once approved)
```

Then on the server, in `C:\Project_Peruse`, as administrator:

```
git pull
npm install --omit=dev
schtasks /End /TN "Prefects App"
schtasks /Run /TN "Prefects App"
```

If the push is rejected, `prod` has commits that `dev` lacks. Merge `prod` into `dev` first. Do not force-push.

### Turn on HTTPS

Without it, anyone on the same Wi-Fi with the right tools can read passwords as they are sent, and
students share that network. Export a certificate as a `.pfx` file, then copy `.env.example` to
`.env`, set `HTTPS_PFX` and `HTTPS_PFX_PASSPHRASE`, and restart the app. A self-signed certificate
gives a browser warning on each phone unless the school's own certificate authority issued it.

### Backups

A copy of the database is written to `data\backups` once a day, and the latest 30 are kept. That
folder is on the same disk, so include `data` in the server's normal backup as well.

To restore: stop the app, delete `prefects.db-wal` and `prefects.db-shm` from `data`, replace
`data\prefects.db` with a backup copy, and start the app.

The `data` folder holds student disciplinary records. Restrict it to administrators.

## Loading the real student list

1. In Excel, use File > Save As > **CSV UTF-8**. The file needs a heading row and these columns:
   - **Form** (for example `3 Plato`)
   - **Surname** and **First Name**, or a single **Name** column
   - **Student No** (optional, but it makes next year's import more reliable)
2. Go to Admin > Students > Import CSV.
3. Go to Admin > Students > Remove all test data. This deletes the made-up students and Test
   Prefect accounts, and everything linked to them.

## How the rules work

- A student goes on a list after 2 demerits for that list. Admins can change this in Admin > Demerit types.
- The two lists are counted separately. Each group of 2 becomes one row, and any extra demerit waits.
- Serious demerit types go straight on the next list. A prefect can also send one straight on when
  a teacher asked them to and they enter the teacher's name.
- Creating a list is the cut-off. Anything recorded afterwards goes on the next list.
- The printed list says "Hellenic Prefects" or the teacher's name. Only admins see which prefect
  recorded a demerit.
- Prefects can give many demerits at once from Find > Bulk upload: choose the list and one reason, then
  add the students. Either all of them are recorded or none are. Reasons that go straight on a list
  (C1) are offered to admins only.
- Admins choose which prefects are on duty for each list.
- Any prefect can mark a register. Each tick or cross saves straight away. Start session starts the clock
  and folds the names away; they can be opened again to make changes.
- A student marked present after the first time on the list is flagged late: 6:45 AM for Dress Parade and
  14:00 for Manual Labour, unless the list says otherwise. The flag has no other effect.
- If a prefect who is not on duty changes a register or starts a session, the admins get an alert on the
  Admin page, one per prefect per list until dismissed.
- Prefects on duty and admins can end the session. That marks anyone unmarked as a no-show, and
  no-shows go on the next list of that type.
- At the start of each term, an admin presses Admin > Start new term. Part-way counts go back to zero
  and stay in the history. Students who already reached the limit, and no-shows, still go on the next list.

## Tests

`npm test`
