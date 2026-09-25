-- Robot sign-in. Double-click app on Kevin's Desktop, built with scripts/build-robot-signin.sh
-- (osacompile + a URL scheme in Info.plist so a link can open it: robotsignin://site/<host>
-- and robotsignin://all).
--
-- WHY (4 Sep 2026): agents work in a browser profile Kevin signs into by hand, so no agent
-- ever holds a password or a security code. Sessions lapse (GOV.UK One Login after an hour),
-- and a robot that meets a signed-out site leaves ONE line on the task, "SIGN-IN NEEDED:
-- <site>", and stops. This app is Kevin's whole part: one click, a plain Chrome window on the
-- robot profile (mock keychain, no automation attached, exactly as `agent-browser.js login`
-- does), sign in, Cmd+Q, and the next site opens.
--
-- HOW THE CHAIN RUNS (rewritten 8 Sep 2026, after the first morning it was used for real):
--   1. Every waiting site opens in turn: window, sign in, Cmd+Q, next window. Nothing else
--      runs in between. The robot profile can only be open in ONE place, and the old flow
--      started a headless robot run after each window; that run and the next window then
--      fought over the profile, and the run's shell also kept the app's pipe open, so the
--      app sat waiting on a fifteen-minute job. Kevin signed in once and nothing happened.
--   2. The moment each window closes, `agent-dispatch.py signin-done` hands that site's
--      waiting tasks back to their robots (Airtable only, a few seconds). Even if nothing
--      else below runs, the 30-minute hand-back poller works them from there: `queue`
--      counts them as signinReopened hand-backs (15 Sep 2026).
--   3. After the LAST window, ONE pickup run starts through the job queue, fully detached
--      (scripts/detach.py), and works every handed-back task while the sessions are live.
--   Every failure is a notification, never silence: a site that could not open is skipped
--   and named at the end, and the chain carries on.
--
-- ONLY A SITE THAT IS REALLY SIGNED OUT GETS A WINDOW (15 Sep 2026). `signin-waiting`
-- walks each site's door first (agent-browser.js session, or its ledger verdict when under
-- 30 minutes old). A site the robot is already signed into is handed back on the spot and
-- reported under alreadyLive; this app names it in a notification and never opens it. Kevin
-- had been opening Facebook and Pingen windows for sessions that were live all along.
property repo : "/Users/kevinbrittain/Projects/leadership-dashboard"
property waitingFile : "/Users/kevinbrittain/knowledge-os/logs/signin-pickup/waiting.json"

on nodeBin()
	return do shell script "ls -d /Users/kevinbrittain/.nvm/versions/node/*/bin/node | sort -V | tail -1"
end nodeBin

on sh(cmd)
	return do shell script "cd " & quoted form of repo & " && " & cmd
end sh

-- Every sign-in this app can open, as "label | host | url | profile" lines. One line per robot
-- profile, not per site (25 Sep 2026): each Duckworth flat is its own Utilita login in its own
-- profile, and while this list held only the main profile the watcher's "open the Robot sign-in
-- app" line sent Kevin somewhere that could not sign either flat back in.
on allSites()
	set got to splitSiteList(sh(quoted form of nodeBin() & " scripts/agent-browser.js signin-list 2>&1"))
	if (count of (skipped of got)) > 0 then
		set AppleScript's text item delimiters to "; "
		display notification ((skipped of got) as text) with title "Robot sign-in: a sign-in could not be listed"
		set AppleScript's text item delimiters to ""
	end if
	return sites of got
end allSites

-- signin-list names an unusable profile entry on a "SKIPPED: " line. `do shell script` drops
-- stderr on success, so those lines come through stdout and are said out loud here, never
-- offered as a site (found in review, 25 Sep 2026: a flat could vanish from the list in silence).
on splitSiteList(raw)
	set theSites to {}
	set theSkipped to {}
	repeat with L in paragraphs of raw
		set L to L as text
		if L starts with "SKIPPED: " then
			set end of theSkipped to text 10 thru -1 of L
		else if L is not "" then
			set end of theSites to L
		end if
	end repeat
	return {sites:theSites, skipped:theSkipped}
end splitSiteList

-- The first line of the full list: give the robot a site it has never had.
property addNewItem : "+ Add a new site…"

on fieldCount(theLine)
	set AppleScript's text item delimiters to " | "
	set n to count of text items of theLine
	set AppleScript's text item delimiters to ""
	return n
end fieldCount

-- The robot profile a line signs into. Lines from waitingSites() carry three fields: a task
-- waiting on a site always means the main profile.
on profileOf(theLine)
	if fieldCount(theLine) < 4 then return "default"
	return fieldOf(theLine, 4)
end profileOf

-- A line for runChain from what Kevin typed. " | " separates the fields, so a bar in the name
-- would shift the url into the host's place.
on newSiteLine(theName, theHost, theUrl)
	set AppleScript's text item delimiters to {return, linefeed}
	set bits to text items of theName
	set AppleScript's text item delimiters to " "
	set theName to bits as text
	set AppleScript's text item delimiters to "|"
	set bits to text items of theName
	set AppleScript's text item delimiters to "-"
	set theName to bits as text
	set AppleScript's text item delimiters to ""
	if theName is "" then set theName to theHost
	-- The fifth field marks a site Kevin added on purpose: `login --add` may then record a
	-- sibling of a listed site (www.youtube.com beside studio.youtube.com) as its own site.
	return theName & " | " & theHost & " | " & theUrl & " | default | new"
end newSiteLine

-- "Add a new site…" (25 Sep 2026): Kevin pastes the site's sign-in page and names it, and the
-- window opens as for any other site. `login` puts the site on the allowlist WITH that page, so
-- it is on this list for every sign-in after, and the daily keep-alive visits it. Returns the
-- lines for runChain: {} when he cancels or the address is not an https one, and the site's own
-- lines when it is already on the list, so a site with its own profiles (a Utilita flat) opens
-- on those and never on the main one (found in review).
on askNewSite()
	try
		set theUrl to text returned of (display dialog "Paste the address of the site's sign-in page. The robots will be able to use this site once you have signed in." default answer "https://" with title "Robot sign-in: add a site" buttons {"Cancel", "Next"} default button "Next" cancel button "Cancel")
	on error number -128
		return {}
	end try
	-- Node parses it, so a pasted address with stray spaces comes back clean: host, then href.
	try
		set parsed to paragraphs of sh(quoted form of nodeBin() & " -e " & quoted form of "const u=new URL(process.argv[1]);if(u.protocol!=='https:'||!u.hostname.includes('.')||u.username||u.password)process.exit(1);console.log(u.hostname.toLowerCase()+'\\n'+u.href)" & " " & quoted form of theUrl)
		set theHost to item 1 of parsed
		set theUrl to item 2 of parsed
	on error
		display alert "That is not a sign-in page address" message "It needs to start with https:// and name a website, with no name or password in it. Nothing was added."
		return {}
	end try
	-- The site this address belongs to, resolved as the task side resolves a sign-in line: its
	-- own entry, a parent (www.tax.service.gov.uk is HMRC) or a sibling (www.utilita.co.uk is
	-- the two flats). Only an address nothing owns is a new site.
	set known to sites of splitSiteList(sh(quoted form of nodeBin() & " scripts/agent-browser.js signin-list --for " & quoted form of theUrl & " 2>&1"))
	if (count of known) > 0 then
		display notification theHost & " is already on the list as " & fieldOf(item 1 of known, 1) & ". Opening it." with title "Robot sign-in"
		return known
	end if
	try
		set theName to text returned of (display dialog "What should the robots call this site?" default answer theHost with title "Robot sign-in: add a site" buttons {"Cancel", "Open sign-in"} default button "Open sign-in" cancel button "Cancel")
	on error number -128
		return {}
	end try
	return {newSiteLine(theName, theHost, theUrl)}
end askNewSite

-- Ask the engine ONCE what is waiting and keep its answer in a file the readers below
-- share. signin-waiting checks every site's session before it answers and hands back the
-- tasks of any site the robot is already signed into, so it is run once per chain, never
-- once per question (a second run would walk the doors again and find nothing to hand back).
-- onlyHost: "" checks every waiting site; a host checks that one (the per-site link).
-- A failed check is a notification and an empty answer, never a raw error dialog.
on refreshWaiting(onlyHost)
	set siteArg to ""
	if onlyHost is not "" then set siteArg to " --site " & quoted form of onlyHost
	try
		sh("mkdir -p " & quoted form of (do shell script "dirname " & quoted form of waitingFile) & " && /usr/bin/python3 scripts/agent-dispatch.py signin-waiting" & siteArg & " > " & quoted form of waitingFile)
	on error errMsg
		display notification "Could not check the sites: " & errMsg with title "Robot sign-in"
		try
			sh("echo '{\"sites\":[],\"alreadyLive\":[]}' > " & quoted form of waitingFile)
		end try
	end try
end refreshWaiting

-- An unreadable or missing answer reads as nothing waiting, never as an error dialog.
on readWaiting(js)
	set theCode to "const d=JSON.parse(require('fs').readFileSync('" & waitingFile & "','utf8'));" & js
	try
		set raw to sh(quoted form of nodeBin() & " -e " & quoted form of theCode)
	on error
		return {}
	end try
	if raw is "" then return {}
	return paragraphs of raw
end readWaiting

-- Sites with a task waiting on them AND really signed out, in the order the pickup should
-- work them (short-session sites such as GOV.UK first), same line shape. A task naming a
-- site the robot cannot sign into is reported, never opened (see unknownWaiting).
on waitingSites()
	return readWaiting("for(const g of d.sites){if(g.loginUrl&&g.host!=='unknown')console.log(g.label+' ('+g.tasks.length+' waiting) | '+g.host+' | '+g.loginUrl)}")
end waitingSites

-- Tasks whose SIGN-IN NEEDED line names a site that is not on the robot's list.
on unknownWaiting()
	return readWaiting("for(const g of d.sites){if(!(g.loginUrl&&g.host!=='unknown'))for(const t of g.tasks)console.log(t.name.slice(0,60)+' -> '+g.label.slice(0,50))}")
end unknownWaiting

-- Sites the robot was already signed into: "label | host | tasks handed back" lines.
-- signin-waiting has already handed those tasks back; no window is opened for them.
on alreadyLive()
	return readWaiting("for(const g of (d.alreadyLive||[])){const n=(g.handedBack||[]).filter(h=>!h.closed).length;console.log(g.label+' | '+g.host+' | '+n)}")
end alreadyLive

-- Say which sites needed no window, and return how many tasks they handed back.
on announceLive()
	set n to 0
	set labels to {}
	repeat with L in alreadyLive()
		set n to n + ((fieldOf(L as text, 3)) as integer)
		set end of labels to fieldOf(L as text, 1)
	end repeat
	if (count of labels) > 0 then
		set AppleScript's text item delimiters to ", "
		display notification "Already signed in to " & (labels as text) & ": " & n & " task(s) handed straight back, no window needed." with title "Robot sign-in"
		set AppleScript's text item delimiters to ""
	end if
	return n
end announceLive

on liveHosts()
	set hosts to {}
	repeat with L in alreadyLive()
		set end of hosts to fieldOf(L as text, 2)
	end repeat
	return hosts
end liveHosts

on fieldOf(theLine, n)
	set AppleScript's text item delimiters to " | "
	set v to text item n of theLine
	set AppleScript's text item delimiters to ""
	return v
end fieldOf

-- The window command for one line, on that line's profile. Only a four-field line carries a
-- clean name (a waiting line's reads "Pingen (2 waiting)"), and the name is used only when the
-- site is new to the allowlist. stderr stays out of stdout: `do shell script` reports stderr as
-- the error text, and that is what signInTo's notification shows. stdout is read for NOTE lines.
on loginCommand(theLine)
	set extra to ""
	if fieldCount(theLine) > 3 then set extra to " --label " & quoted form of fieldOf(theLine, 1)
	if fieldCount(theLine) > 4 then
		if fieldOf(theLine, 5) is "new" then set extra to extra & " --add"
	end if
	return quoted form of nodeBin() & " scripts/agent-browser.js login --url " & quoted form of fieldOf(theLine, 3) & " --profile " & quoted form of profileOf(theLine) & extra
end loginCommand

-- What `login` said that Kevin must hear: its NOTE lines (a site it could not record, and why).
-- Before this the app sent login's output to /dev/null, so "gov.uk is read-only, not recorded"
-- reached nobody and the site was simply missing from the list next time (found in review).
on notesIn(theOutput)
	set theNotes to {}
	repeat with L in paragraphs of theOutput
		if (L as text) starts with "NOTE: " then set end of theNotes to text 7 thru -1 of (L as text)
	end repeat
	return theNotes
end notesIn

-- One site: open the window, wait for Cmd+Q, hand the waiting tasks back.
-- Returns the number of tasks handed back, or -1 if the window could not open.
on signInTo(theLine)
	set theHost to fieldOf(theLine, 2)
	set theUrl to fieldOf(theLine, 3)
	set theLabel to fieldOf(theLine, 1)
	set theProfile to profileOf(theLine)
	display notification "Sign in, then press Cmd+Q on the Chrome window." with title "Robot sign-in: " & theLabel
	try
		set said to sh(loginCommand(theLine))
		repeat with N in notesIn(said)
			display notification (N as text) with title "Robot sign-in: " & theLabel
		end repeat
	on error errMsg
		display notification "Could not open the window: " & errMsg with title "Robot sign-in: " & theLabel
		return -1
	end try
	-- A task waiting on a site means the main profile. A sign-in to any other profile (a
	-- Utilita flat) hands nothing back: its reader runs on its own clock.
	if theProfile is not "default" then
		display notification "Signed in. The robot holds this login in its own browser." with title "Robot sign-in: " & theLabel
		return 0
	end if
	-- Hand this site's waiting tasks back to their robots now (Airtable only,
	-- seconds). The pickup run itself starts once every window has closed.
	try
		set n to sh("/usr/bin/python3 scripts/agent-dispatch.py signin-done --site " & quoted form of theHost & " | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin).get(\"handedBack\", [])))'")
		set n to n as integer
		if n is 0 then
			display notification "Signed in. Nothing was waiting on this site." with title "Robot sign-in: " & theLabel
		else
			display notification "Signed in. " & n & " task(s) handed back to the robots." with title "Robot sign-in: " & theLabel
		end if
		return n
	on error errMsg
		display notification "Signed in, but the hand-back failed: " & errMsg with title "Robot sign-in: " & theLabel
		return 0
	end try
end signInTo

-- Start the one pickup run, detached, through the job queue. Returns true if it started.
on startPickup()
	try
		sh("/usr/bin/python3 scripts/detach.py --cwd " & quoted form of repo & " -- /usr/bin/python3 scripts/job-queue.py run signin-pickup -- " & quoted form of (repo & "/scripts/signin-pickup-run.sh") & " > /dev/null")
		return true
	on error errMsg
		display notification "Signed in, but could not start the robot: " & errMsg with title "Robot sign-in"
		return false
	end try
end startPickup

-- theLines: the sites to open in turn. liveHanded: tasks already handed back by
-- signin-waiting for sites that needed no window; they ride the same pickup.
on runChain(theLines, liveHanded)
	set handed to liveHanded
	set failed to {}
	repeat with L in theLines
		set n to signInTo(L as text)
		if n is -1 then
			set end of failed to fieldOf(L as text, 1)
		else
			set handed to handed + n
		end if
	end repeat
	set tail to ""
	if (count of failed) > 0 then
		set AppleScript's text item delimiters to ", "
		set tail to " Could not open: " & (failed as text) & "."
		set AppleScript's text item delimiters to ""
	end if
	if handed > 0 then
		if startPickup() then
			display notification "All signed in. Pickup queued for " & handed & " task(s); the robots start when the queue is free." & tail with title "Robot sign-in"
		else
			display notification "Signed in; the " & handed & " task(s) are on the board and the 30-minute poll works them (it counts a sign-in as a hand-back)." & tail with title "Robot sign-in"
		end if
	else
		display notification "All done. Nothing was waiting on a robot." & tail with title "Robot sign-in"
	end if
end runChain

-- Double-click: waiting sites first; if none, offer the full list.
on run
	display notification "Checking which sites are really signed out (up to a minute per site)…" with title "Robot sign-in"
	refreshWaiting("")
	set liveN to announceLive()
	set waiting to waitingSites()
	if (count of waiting) > 0 then
		set choice to choose from list waiting with title "Robot sign-in" with prompt "These sites have work waiting and are signed out. Open them one after another? (sign in, Cmd+Q, next opens)" OK button name "Start" cancel button name "Pick a site instead" with multiple selections allowed
		if choice is not false then
			runChain(choice, liveN)
			return
		end if
	else if liveN > 0 then
		-- Every waiting site was already signed in: nothing to open, only the pickup to start.
		runChain({}, liveN)
		return
	end if
	-- Several at once (Cmd-click): the watcher's message can ask for both Utilita flats.
	set choice to choose from list ({addNewItem} & allSites()) with title "Robot sign-in" with prompt "Which sites should the robot be signed into? Cmd-click to pick several. Pick the first line to give it a new one." OK button name "Open" cancel button name "Cancel" with multiple selections allowed
	if choice is false then
		if liveN > 0 then runChain({}, liveN)
		return
	end if
	set theLines to {}
	repeat with c in choice
		if (c as text) is addNewItem then
			set theLines to theLines & askNewSite()
		else
			set end of theLines to (c as text)
		end if
	end repeat
	if (count of theLines) is 0 and liveN is 0 then return
	runChain(theLines, liveN)
end run

-- A link: robotsignin://all opens every waiting site in turn; robotsignin://site/<host> opens one.
-- "robotsignin://" is 14 characters, so the body starts at 15 (found in review).
on bodyOf(theURL)
	return text 15 thru -1 of theURL
end bodyOf

on open location theURL
	set body to bodyOf(theURL)
	if body starts with "all" then
		display notification "Checking which sites are really signed out (up to a minute per site)…" with title "Robot sign-in"
		refreshWaiting("")
		set liveN to announceLive()
		set waiting to waitingSites()
		set unknown to unknownWaiting()
		if (count of unknown) > 0 then
			set AppleScript's text item delimiters to "; "
			display notification ((count of unknown) as text) & " task(s) name a site the robot cannot sign into: " & (unknown as text) with title "Robot sign-in: not on the list"
			set AppleScript's text item delimiters to ""
		end if
		if (count of waiting) is 0 then
			if liveN > 0 then
				runChain({}, liveN)
			else
				display notification "Nothing is waiting on a sign-in the robot can use." with title "Robot sign-in"
			end if
			return
		end if
		runChain(waiting, liveN)
		return
	end if
	if body starts with "site/" then
		set wantHost to text 6 thru -1 of body
		-- The card links the host from the agent's own URL (www.pingen.com); the
		-- robot's entry may be a sibling (app.pingen.com). Resolve it the way
		-- signin-waiting does before giving up.
		try
			set wantHost to sh("/usr/bin/python3 scripts/agent-dispatch.py signin-site --url " & quoted form of ("https://" & wantHost & "/") & " --site " & quoted form of wantHost)
		on error
			-- leave wantHost as it came; the exact match below still applies
		end try
		-- Check the session before opening anything: a site the robot is already
		-- signed into has its tasks handed back by this call and gets no window.
		display notification "Checking whether the robot is already signed in to " & wantHost & "…" with title "Robot sign-in"
		refreshWaiting(wantHost)
		set liveN to announceLive()
		if liveHosts() contains wantHost then
			runChain({}, liveN)
			return
		end if
		-- Every sign-in on that host, in turn: robotsignin://site/my.utilita.co.uk opens both flats.
		set matches to {}
		repeat with L in allSites()
			if fieldOf(L as text, 2) is wantHost then set end of matches to (L as text)
		end repeat
		if (count of matches) > 0 then
			runChain(matches, liveN)
			return
		end if
		display alert "Unknown site" message wantHost & " is not on the robot's sign-in list."
	end if
end open location
