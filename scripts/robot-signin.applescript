-- Robot sign-in. Double-click app on Kevin's Desktop, built from this source with:
--   osacompile -o ~/Desktop/"Robot sign-in.app" scripts/robot-signin.applescript
--
-- WHY (4 Sep 2026): agents work in a browser profile Kevin signs into by hand, so no
-- agent ever holds a password or a security code. Sessions lapse (GOV.UK One Login
-- after an hour; others when the site decides), and 37 outputs in 14 days handed him
-- "log in to X and do it yourself" because a site had no session. This app is the one
-- tap: pick the site, a plain Chrome window opens on the robot profile (mock keychain,
-- no automation attached, exactly as `agent-browser.js login` does), sign in, Cmd+Q.
-- The list is read live from the allowlist (`agent-browser.js sites`), so a site added
-- there appears here without touching this file.
set repo to "/Users/kevinbrittain/Projects/leadership-dashboard"
set nodeBin to do shell script "ls -d /Users/kevinbrittain/.nvm/versions/node/*/bin/node | sort -V | tail -1"
set listing to do shell script "cd " & quoted form of repo & " && " & quoted form of nodeBin & " -e \"const s=require('./scripts/agent-browser.js').loadSites();for(const [h,v] of Object.entries(s)){if(v.login&&v.loginUrl)console.log(v.label+' | '+v.loginUrl)}\""
set theLines to paragraphs of listing
if (count of theLines) is 0 then
	display alert "No sign-in sites listed" message "The allowlist has no site with a login URL."
	return
end if
set choice to choose from list theLines with title "Robot sign-in" with prompt "Which site should the robot be signed into? A Chrome window opens: sign in, then Cmd+Q it." OK button name "Open" cancel button name "Cancel"
if choice is false then return
set chosen to item 1 of choice
set AppleScript's text item delimiters to " | "
set theUrl to text item 2 of chosen
set AppleScript's text item delimiters to ""
set cmd to quoted form of nodeBin & " " & quoted form of (repo & "/scripts/agent-browser.js") & " login --url " & quoted form of theUrl
display notification "Sign in, then Cmd+Q the Chrome window. Then approve the waiting task: the robot picks it up within 30 minutes." with title "Robot sign-in"
try
	do shell script "cd " & quoted form of repo & " && " & cmd & " > /dev/null 2>&1 &"
on error errMsg
	display alert "Could not open the sign-in window" message errMsg
end try
