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

-- Every allowlisted login site as "label | host | url" lines.
on allSites()
	set js to "const s=require('./scripts/agent-browser.js').loadSites();for(const [h,v] of Object.entries(s)){if(v.login&&v.loginUrl)console.log(v.label+' | '+h+' | '+v.loginUrl)}"
	return paragraphs of sh(quoted form of nodeBin() & " -e " & quoted form of js)
end allSites

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

-- One site: open the window, wait for Cmd+Q, hand the waiting tasks back.
-- Returns the number of tasks handed back, or -1 if the window could not open.
on signInTo(theLine)
	set theHost to fieldOf(theLine, 2)
	set theUrl to fieldOf(theLine, 3)
	set theLabel to fieldOf(theLine, 1)
	display notification "Sign in, then press Cmd+Q on the Chrome window." with title "Robot sign-in: " & theLabel
	try
		-- stdout only to /dev/null: `do shell script` reports stderr as the error
		-- text, and that is what the notification below shows.
		sh(quoted form of nodeBin() & " scripts/agent-browser.js login --url " & quoted form of theUrl & " > /dev/null")
	on error errMsg
		display notification "Could not open the window: " & errMsg with title "Robot sign-in: " & theLabel
		return -1
	end try
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
	set choice to choose from list allSites() with title "Robot sign-in" with prompt "Which site should the robot be signed into?" OK button name "Open" cancel button name "Cancel"
	if choice is false then
		if liveN > 0 then runChain({}, liveN)
		return
	end if
	runChain(choice, liveN)
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
		repeat with L in allSites()
			if fieldOf(L as text, 2) is wantHost then
				runChain({L as text}, liveN)
				return
			end if
		end repeat
		display alert "Unknown site" message wantHost & " is not on the robot's sign-in list."
	end if
end open location
