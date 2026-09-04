-- Robot sign-in (GOV.UK One Login). Double-click app on Kevin's Desktop, built from
-- this source with:  osacompile -o ~/Desktop/"Robot sign-in (GOV.UK).app" scripts/robot-signin.applescript
--
-- WHY (4 Sep 2026): Companies House WebFiling signs in through GOV.UK One Login, and
-- that session expires one hour after Kevin's last interaction. Every sign-in needs his
-- password and security code, which no agent may ever hold, so the agent hands back
-- "SIGN-IN NEEDED: GOV.UK One Login" and Kevin has to run `agent-browser.js login`.
-- He cannot be asked to open a terminal, so this app is the one tap that runs it:
-- a plain Chrome window on the robot profile (mock keychain, no automation attached),
-- exactly as the `login` command does. Sign in, Cmd+Q the window, then approve the task.
set repo to "/Users/kevinbrittain/Projects/leadership-dashboard"
set nodeBin to "/Users/kevinbrittain/.nvm/versions/node/v24.15.0/bin/node"
set cmd to quoted form of nodeBin & " " & quoted form of (repo & "/scripts/agent-browser.js") & " login --url https://signin.account.gov.uk/enter-email"
display notification "Sign in, then Cmd+Q the Chrome window. Afterwards approve the task: the robot picks it up within 30 minutes." with title "Robot sign-in (GOV.UK One Login)"
try
	do shell script "cd " & quoted form of repo & " && " & cmd & " > /dev/null 2>&1 &"
on error errMsg
	display alert "Could not open the sign-in window" message errMsg
end try
