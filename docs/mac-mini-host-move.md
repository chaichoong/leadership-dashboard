# Moving the estate to the Mac mini

**What this is:** the running order for moving Kevin's Mac setup, and every scheduled job with it, from the
MacBook Air to the new Mac mini on Sunday 27 Sep 2026. Written 24 Sep 2026. The script that does the risky
part is `scripts/host-move.py`; this page says who does what and when.

**The one rule:** the jobs must only ever run on one Mac. Migration Assistant copies them, and the job lock
lives on one machine, so a live copy makes every job fire twice. The jobs are **paused on the Air before the
copy** and **resumed on the mini after it**. Nothing runs anywhere in between.

---

## How long

| Part | Where | Hands-on | Elapsed |
|---|---|---|---|
| A. Pause the jobs | Air | 10 min | 15 min |
| B. Start the mini and the copy | Mini + Air | 20 min | 20 min |
| C. The copy runs | Both | 0 | 1 to 3 hours |
| D. Finish the mini | Mini | 45 min | 45 min |
| E. Hand the jobs to the mini | Mini | 10 min | 20 min |
| F. The desk | Mini + Air | 15 min | 15 min |

**Total: about 3.5 to 5 hours elapsed, about 1 hour 40 of it hands-on.** The jobs are paused for most of it.
Start by 10:00 so everything is back before the 22:00 Content Engine run.

The copy is the long part and needs no one watching. Start it, then go for your run.

---

## Before Sunday

1. **A fast cable, if you have one.** A Thunderbolt 4 or USB4 cable between the two Macs is the quickest copy.
   The Air's charging cable is USB 2 speed and slower than Wi-Fi, so without a fast cable, copy over Wi-Fi.
2. **A USB-C to Lightning cable.** The keyboard and trackpad pair by cable on first boot.
3. **Screenshot the Air's privacy lists.** System Settings, Privacy & Security, then each of: Full Disk
   Access, Accessibility, Automation, Screen Recording, Files and Folders. These permissions **do not
   copy across**, and jobs that read Messages, WhatsApp, Notes or the Home database fail silently without
   them.

---

## A. Pause the jobs (on the Air)

Open the Claude desktop app on the Air, start a session in `leadership-dashboard`, and paste:

> Host move, part A. Refresh the main checkout to origin/main. Run
> `python3 scripts/host-move.py plan` and show me the result. If it reports uncommitted or unpushed work,
> commit and push it. Then run `python3 scripts/host-move.py pause` and show me the result. Then switch
> OFF the daily-ops scheduled task on this Mac, or tell me exactly where to click. Change nothing else.

**Done when:** the pause result says `"ok": true` with a `paused` count, and daily-ops shows OFF in the
Air's Claude app. If a job is mid-run, `pause` waits up to 15 minutes for it to finish.

---

## B. Start the mini and the copy

1. Connect the mini: power, Ethernet, one monitor on HDMI, and the keyboard and trackpad by the
   USB-C to Lightning cable.
2. Switch it on. Choose language and country, and **join Wi-Fi** even with the cable in.
3. **Stop at the screen offering to transfer your information.** Choose **From a Mac**.
   **Do not choose "Not now" and do not create an account.** Every job expects the account name
   `kevinbrittain`. Creating an account first gives you a second account and breaks every job path.
4. On the Air, open **Migration Assistant** (Applications, Utilities) and choose **To another Mac**.
   Plug in the fast cable now if you have one.
5. Check the two codes match. Select **Applications**, **your user account**, **Other files and folders**
   and **Computer & Network Settings**. Keep the account name as it is.
6. Start the copy.

## C. The copy runs

One to three hours, depending on the cable and how much is on the Air. Leave both Macs alone.

---

## D. Finish the mini

1. Log in on the mini.
2. Sign in to: your Apple Account if asked, **Google Drive for desktop** (wait until the drive shows in
   Finder), and the **Claude desktop app**.
3. **System Settings, Energy.** Switch on all three:
   - Prevent automatic sleeping when the display is off
   - Wake for network access
   - Start up automatically after a power failure
4. **System Settings, Privacy & Security.** Make each list match the Air's screenshots.
5. Leave **Wi-Fi on**. Universal Control and AirDrop need it even with the cable in.

---

## E. Hand the jobs to the mini

Open the Claude desktop app on the mini, start a session in `leadership-dashboard`, and paste:

> Host move, part E. Run `python3 scripts/host-move.py resume` and show me the result. If it refuses,
> fix what it names or tell me exactly what to click, then run it again. Then switch ON the daily-ops
> scheduled task on this Mac. Wait 10 minutes, run `python3 scripts/host-move.py verify`, fix anything
> marked FAIL, and report what is left.

Then open **Robot sign-in** on the Desktop and sign in to each site. Browser sessions often do not
survive the copy, and `session-keepalive` will raise a sign-in task for any you miss.

**Done when:** `verify` shows no FAIL, daily-ops is ON on the mini and OFF on the Air.

`resume` refuses to run on the Air, so the paused copy left there cannot be switched back on by mistake.

---

## F. The desk

1. Second monitor: USB-C to HDMI adapter into a USB-C port on the mini.
2. System Settings, Displays: arrange the two monitors.
3. System Settings, Displays, Advanced: switch on **Allow your pointer and keyboard to move between any
   nearby Mac or iPad**. Do the same on the Air, then drag the Air's screen into place.
4. Unplug the keyboard and trackpad cables. They stay paired over Bluetooth.

---

## Monday

- The 11:00 Slack digest lists every job, with nothing missing.
- The Estate Status tab on the AI Agents page shows fresh rows.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| The mini is not right and you want the Air back | On the Air: `python3 scripts/host-move.py resume --rollback`, then switch daily-ops back ON on the Air |
| The copy ran before part A | On the Air, run `pause` straight away. The mini will log failures until part D is done; that is expected |
| `resume` says a path does not exist | The account name differs from `kevinbrittain`. Stop and ask before changing anything |
| `verify` says jobs are WAITING | Normal for the first 10 minutes. Run it again |

---

## After the move

- **The Air is now a satellite.** Interactive Claude sessions there are fine. Never run
  `install-slot-jobs.sh` or `resume` on it.
- **The Air keeps an old copy of `~/knowledge-os`.** Do not run anything that writes to the brain from the
  Air until we decide how the Air reaches the mini's copy.
- **UPS:** the Office unit powers the mini with its USB data cable **not** connected. A UPS-triggered
  shutdown can leave the mini off when power returns; without the cable, it restarts on its own.
