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
--      else below runs, the 30-minute hand-back poller works them from there.
--   3. After the LAST window, ONE pickup run starts through the job queue, fully detached
--      (scripts/detach.py), and works every handed-back task while the sessions are live.
--   Every failure is a notification, never silence: a site that could not open is skipped
--   and named at the end, and the chain carries on.
property repo : "/Users/kevinbrittain/Projects/leadership-dashboard"

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

-- Sites with a task waiting on them, in the order the pickup should work them
-- (short-session sites such as GOV.UK first), same line shape. A task naming a
-- site the robot cannot sign into is reported, never opened (see unknownWaiting).
on waitingSites()
	set js to "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const g of d.sites){if(g.loginUrl&&g.host!=='unknown')console.log(g.label+' ('+g.tasks.length+' waiting) | '+g.host+' | '+g.loginUrl)}"
	set raw to sh("/usr/bin/python3 scripts/agent-dispatch.py signin-waiting | " & quoted form of nodeBin() & " -e " & quoted form of js)
	if raw is "" then return {}
	return paragraphs of raw
end waitingSites

-- Tasks whose SIGN-IN NEEDED line names a site that is not on the robot's list.
on unknownWaiting()
	set js to "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const g of d.sites){if(!(g.loginUrl&&g.host!=='unknown'))for(const t of g.tasks)console.log(t.name.slice(0,60)+' -> '+g.label.slice(0,50))}"
	set raw to sh("/usr/bin/python3 scripts/agent-dispatch.py signin-waiting | " & quoted form of nodeBin() & " -e " & quoted form of js)
	if raw is "" then return {}
	return paragraphs of raw
end unknownWaiting

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

on runChain(theLines)
	set handed to 0
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
			display notification "Signed in; the 30-minute poller will pick the " & handed & " task(s) up." & tail with title "Robot sign-in"
		end if
	else
		display notification "All done. Nothing was waiting on a robot." & tail with title "Robot sign-in"
	end if
end runChain

-- Double-click: waiting sites first; if none, offer the full list.
on run
	set waiting to waitingSites()
	if (count of waiting) > 0 then
		set choice to choose from list waiting with title "Robot sign-in" with prompt "These sites have work waiting. Open them one after another? (sign in, Cmd+Q, next opens)" OK button name "Start" cancel button name "Pick a site instead" with multiple selections allowed
		if choice is not false then
			runChain(choice)
			return
		end if
	end if
	set choice to choose from list allSites() with title "Robot sign-in" with prompt "Which site should the robot be signed into?" OK button name "Open" cancel button name "Cancel"
	if choice is false then return
	runChain(choice)
end run

-- A link: robotsignin://all opens every waiting site in turn; robotsignin://site/<host> opens one.
-- "robotsignin://" is 14 characters, so the body starts at 15 (found in review).
on bodyOf(theURL)
	return text 15 thru -1 of theURL
end bodyOf

on open location theURL
	set body to bodyOf(theURL)
	if body starts with "all" then
		set waiting to waitingSites()
		set unknown to unknownWaiting()
		if (count of unknown) > 0 then
			set AppleScript's text item delimiters to "; "
			display notification ((count of unknown) as text) & " task(s) name a site the robot cannot sign into: " & (unknown as text) with title "Robot sign-in: not on the list"
			set AppleScript's text item delimiters to ""
		end if
		if (count of waiting) is 0 then
			display notification "Nothing is waiting on a sign-in the robot can use." with title "Robot sign-in"
			return
		end if
		runChain(waiting)
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
		repeat with L in allSites()
			if fieldOf(L as text, 2) is wantHost then
				runChain({L as text})
				return
			end if
		end repeat
		display alert "Unknown site" message wantHost & " is not on the robot's sign-in list."
	end if
end open location
