# Hellenic Academy staff apps

One repository for the school's own web apps on the shared server at `http://10.2.0.190`. Each app has its
own folder, database and Windows scheduled task, and nginx puts them all under one address.

| Folder | Address | What it is | Port |
|---|---|---|---|
| `home/` | `/home/` | The one sign-in page. Prefects go on to demerits; staff see every app. Plain files, served by nginx | none |
| `demerits/` | `/demerits/` | Prefect demerits, Dress Parade and Manual Labour lists | 3080 |
| `sign-ups/` | `/sign_ups/` | Sports and club options | 3081 |

`scripts/` holds the nginx route for each app and one script that installs them all. More apps can be added
as new folders, each with a route file listed in `scripts/setup-nginx.ps1` and a link in `home/public/index.html`.

Everyone signs in on the home page with an account from the demerits app (prefects, and admins as staff).
The sign-in cookie is shared, so set `COOKIE_PATH=/` in `demerits/.env`. Staff are planned to sign in with
their main portal accounts later.

Each app's own README covers running it, its tests and its settings. `npm test` here runs every app's tests.

## Student details stay out of GitHub

This repository is public. Class lists, databases, `.env` files and every `.xlsx` file are ignored by git.
`sign-ups/test/app.test.js` is ignored too, because it uses the real class lists, so it stays on the
development PC. Never add a real student's name to a tracked file. Test data uses invented names only.

## Install on the school server

As administrator, with Node.js 24 LTS installed:

```
git clone -b prod https://github.com/projectwave-commits/Project_Peruse C:\Project_Peruse
cd C:\Project_Peruse\demerits
npm ci --omit=dev
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
cd C:\Project_Peruse\sign-ups
npm ci --omit=dev
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
cd C:\Project_Peruse
powershell -ExecutionPolicy Bypass -File scripts\setup-nginx.ps1
```

Before the sign-ups install, copy its `class-lists` folder in by hand. Each app's README lists its `.env`
settings. The nginx script backs up `nginx.conf` and only applies the change if `nginx -t` passes. The
other sites on that nginx are down for a few seconds while it restarts.

## Releasing a new version

`dev` and `prod` always hold the same code, so every change is pushed to both. A change reaches the
school only when the server pulls it.

```
git push origin dev dev:prod
```

Then, once the change is approved, on the server, as administrator:

```
cd C:\Project_Peruse
git pull
cd demerits;  npm ci --omit=dev; schtasks /End /TN "Prefects App"; schtasks /Run /TN "Prefects App"
cd ..\sign-ups; npm ci --omit=dev; schtasks /End /TN "Sports and Clubs App"; schtasks /Run /TN "Sports and Clubs App"
```

Run `scripts\setup-nginx.ps1` again only when a file in `scripts\` has changed.

If the push is rejected, `prod` has commits that `dev` lacks. Merge `prod` into `dev` first. Do not force-push.

`fake-data` is a separate branch for trying demerits with invented students. It takes code from `dev`, and is
never merged back.
