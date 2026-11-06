# Sports and Club Options

Students choose their sports and clubs on an iPad, laptop or phone. Teachers track progress, enter paper forms, see who is in each club or sport, and download the Excel sheets.

## Setting up on the school server

1. Install [Node.js](https://nodejs.org) version 22.13 or newer (the LTS version is fine).
2. Copy this whole folder to the server.
3. Double-click `start.bat`. The window shows the addresses for students and staff, for example:
   - Students: `http://10.3.1.36:3000/`
   - Staff: `http://10.3.1.36:3000/staff`
4. Allow port 3000 through the server's firewall so that iPads and phones can connect.
5. Open the staff address and sign in. The starting password is `Password1`. You can change it on the **Setup** screen.

The app stops when the `start.bat` window is closed. To keep it running after a restart, add `start.bat` as a Windows Task Scheduler task that runs at startup.

To use a different port, set the `PORT` environment variable.

## Running a registration session

1. On **Progress**, check that registration is open.
2. Open the student address on the device. Add it to the iPad home screen if that's useful.
3. Each student taps their class, then their name, confirms it's them, makes their choices and saves.
4. The device returns to the class list for the next student. Students who are done can no longer be opened.
5. Close registration when the session ends, so that nobody can make changes from the school network between sessions.

Student screens have no password, because a teacher checks each student's name in the line. Anyone on the network can open the student address while registration is open.

## Staff screens

| Screen | Use it to |
| --- | --- |
| **Progress** | See how many students are done per class, and who is left. Open a student to change their choices, add a note, or let them choose again. |
| **Clubs & Sports** | Pick a club or sport to see its students, F1 to U6. Filter by form, add or remove students (for paper forms), print, or download. |
| **Downloads** | Get the option sheet for each form, or every club and sport list in one workbook. |
| **Setup** | Change the term, notes and timetable links. Close a club, set a limit, or add a club. Update class lists, change the password, or start a new term. |

A student marked complete by staff can't reopen their own choices unless a teacher selects **Let student choose again**. A student with a medical exemption can be marked exempt from the primary sport rule on their student page.

## Starting a new term

1. Download the sheets for the old term.
2. On **Setup**, upload the new class lists. Tick the box to remove students who are not in the file only if the file covers the whole school. You will see the changes before anything is saved.
3. Change the term name and timetable links, and review which clubs are offered or closed.
   Session times and clash warnings come from the Third Term 2026 timetables in `src/timetable.js`. If the timetable has changed, update that file or turn clash warnings off on **Setup**.
4. Clear all choices. A backup is saved first.

## Backups

All data is in the `data` folder. To back it up, stop the app and copy that folder. Backups made automatically before an import or a clear are in `data/backups`.

To restore one, stop the app, delete `options.db-wal` and `options.db-shm` from `data` if they exist, replace `data/sign_ups.db` with the backup file (renamed to `options.db`), and start the app again.

## Good to know

- The app uses plain HTTP, so the staff password is not encrypted on the network. Keep it on the school network, and add HTTPS before making it available over the internet.
- The class lists in `class-lists` are only read the first time the app starts. After that, use **Setup** to update them.
- `data` and `class-lists` contain student details, so keep them private.

## For developers

`npm test` runs the tests against a temporary database. The end-to-end tests need `test/app.test.js` and the real class lists, which only the development PC has.

## Running at /sign_ups/ on the shared server

The school server runs this behind nginx at `http://10.2.0.190/sign_ups/`, on the school network only. Staff use `http://10.2.0.190/sign_ups/staff`.

1. Clone the repository to `C:\Project_Peruse`. This app is in its `sign-ups` folder. In `C:\Project_Peruse\sign-ups`, run `npm ci --omit=dev`.
2. Copy the `class-lists` folder into `C:\Project_Peruse\sign-ups` by hand. It is not in the repository, because it holds student details.
3. As administrator, run `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` in the `sign-ups` folder, then `powershell -ExecutionPolicy Bypass -File scripts\setup-nginx.ps1` in `C:\Project_Peruse`, which adds the routes for every app. The other sites on that nginx are down for a few seconds.
4. Sign in on the staff address, change the password on **Setup**, and close registration until a session is due.

Anyone on the school network can open the student screens while registration is open.

## Keeping student details out of GitHub

`class-lists`, `data` and every `.xlsx` file are ignored by git. `test/app.test.js` is ignored too, because it is built around the real class lists and contains real names, so it stays on the development PC. `test/subpath.test.js` uses no student details. Never add real names to a tracked file.
