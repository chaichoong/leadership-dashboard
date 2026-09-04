-- Robot sign-in (GOV.UK One Login). Double-click app on Kevin's Desktop, built from
-- this source with:  osacompile -o ~/Desktop/"Robot sign-in (GOV.UK).app" scripts/robot-signin.applescript
--
-- WHY (4 Sep 2026): Companies House WebFiling signs in through GOV.UK One Login, and
-- that session expires one hour after Kevin's last interaction. Every sign-in needs his
-- password and security code, which no agent may ever hold, so the agent hands back
-- "SIGN-IN NEEDED: GOV.UK One Login" and Kevin has to run `agent-browser.js login`.
-- He cannot be asked to open a terminal, so this app is the one tap that runs it:
-- a plain Chrome window on the robot profile (mock keychain, no automation attached),
-- exactly as the `login` command does. The window opens at the WEBFILING entry, not at
-- One Login itself: a standalone One Login sign-in did not carry into WebFiling's own
-- sign-in request (proven 4 Sep 2026: the account cookie was there and readable, WebFiling
-- still asked for email, password and code). Continue > Go to GOV.UK One Login > sign in
-- > land on the company list, then Cmd+Q the window, then approve the task.
set repo to "/Users/kevinbrittain/Projects/leadership-dashboard"
set nodeBin to do shell script "ls -d /Users/kevinbrittain/.nvm/versions/node/*/bin/node | sort -V | tail -1"
set cmd to quoted form of nodeBin & " " & quoted form of (repo & "/scripts/agent-browser.js") & " login --url https://ewf.companieshouse.gov.uk/seclogin?tc=1"
display notification "Sign in, then Cmd+Q the Chrome window. Afterwards approve the task: the robot picks it up within 30 minutes." with title "Robot sign-in (GOV.UK One Login)"
try
	do shell script "cd " & quoted form of repo & " && " & cmd & " > /dev/null 2>&1 &"
on error errMsg
	display alert "Could not open the sign-in window" message errMsg
end try
