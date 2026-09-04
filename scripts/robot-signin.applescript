-- Robot sign-in. Double-click app on Kevin's Desktop, built with scripts/build-robot-signin.sh
-- (osacompile + a URL scheme in Info.plist so a link can open it: robotsignin://site/<host>
-- and robotsignin://all).
--
-- WHY (4 Sep 2026): agents work in a browser profile Kevin signs into by hand, so no agent
-- ever holds a password or a security code. Sessions lapse (GOV.UK One Login after an hour),
-- and a robot that meets a signed-out site leaves ONE line on the task, "SIGN-IN NEEDED:
-- <site>", and stops. This app is Kevin's whole part: one click, a plain Chrome window on the
-- robot profile (mock keychain, no automation attached, exactly as `agent-browser.js login`
-- does), sign in, Cmd+Q. The moment the window closes the app runs `agent-dispatch.py
-- signin-done`, which hands every task waiting on that site straight back to its robot, and
-- then opens the next site in the list. The profile can only be open in one window at a
-- time, which is why the sites open one after another and never all at once.
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

-- Sites with a task waiting on them, most tasks first, same line shape.
on waitingSites()
	set js to "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const g of d.sites){if(g.loginUrl&&g.host!=='unknown')console.log(g.label+' ('+g.tasks.length+' waiting) | '+g.host+' | '+g.loginUrl)}"
	set raw to sh("/usr/bin/python3 scripts/agent-dispatch.py signin-waiting | " & quoted form of nodeBin() & " -e " & quoted form of js)
	if raw is "" then return {}
	return paragraphs of raw
end waitingSites

on fieldOf(theLine, n)
	set AppleScript's text item delimiters to " | "
	set v to text item n of theLine
	set AppleScript's text item delimiters to ""
	return v
end fieldOf

-- One site: open the window, wait for Cmd+Q, then hand the waiting tasks back.
on signInTo(theLine)
	set theHost to fieldOf(theLine, 2)
	set theUrl to fieldOf(theLine, 3)
	display notification "Sign in, then press Cmd+Q on the Chrome window." with title "Robot sign-in: " & fieldOf(theLine, 1)
	sh(quoted form of nodeBin() & " scripts/agent-browser.js login --url " & quoted form of theUrl & " > /dev/null 2>&1")
	-- Hand the site's waiting tasks back and wake the robot NOW, in the background,
	-- through the job queue so it holds the lock like every other job. The app moves
	-- straight on to the next site while that run works.
	try
		sh("nohup /usr/bin/python3 scripts/job-queue.py run signin-pickup -- " & quoted form of (repo & "/scripts/signin-pickup-run.sh") & " " & quoted form of theHost & " > /dev/null 2>&1 &")
		display notification "Handing the waiting tasks to the robot now." with title "Robot sign-in: " & fieldOf(theLine, 1)
	on error errMsg
		display notification "Signed in, but could not start the robot: " & errMsg with title "Robot sign-in"
	end try
end signInTo

on runChain(theLines)
	repeat with L in theLines
		signInTo(L as text)
	end repeat
	display notification "All done. The robots are working." with title "Robot sign-in"
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
		if (count of waiting) is 0 then
			display notification "Nothing is waiting on a sign-in." with title "Robot sign-in"
			return
		end if
		runChain(waiting)
		return
	end if
	if body starts with "site/" then
		set wantHost to text 6 thru -1 of body
		repeat with L in allSites()
			if fieldOf(L as text, 2) is wantHost then
				runChain({L as text})
				return
			end if
		end repeat
		display alert "Unknown site" message wantHost & " is not on the robot's sign-in list."
	end if
end open location
