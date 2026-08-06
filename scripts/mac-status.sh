#!/bin/bash
# Plain-English health check for this Mac's memory.
#
# Why this exists (6 Aug 2026): the machine was crawling and nobody could say
# why. "Memory used" in Activity Monitor does not answer it, because macOS
# compresses and swaps rather than reporting a shortage. This prints the three
# numbers that actually decide whether the Mac feels fast, and names what is
# holding the memory.
#
# Usage: ./scripts/mac-status.sh

set -uo pipefail

PAGE=$(sysctl -n hw.pagesize)
TOTAL_GB=$(echo "$(sysctl -n hw.memsize) 1073741824" | awk '{printf "%.0f", $1/$2}')
CORES=$(sysctl -n hw.ncpu)

gb () { awk -v p="$1" -v pg="$PAGE" 'BEGIN{printf "%.1f", p*pg/1073741824}'; }

VM=$(vm_stat)
pages () { echo "$VM" | awk -F: -v k="$1" '$1==k{gsub(/[ .]/,"",$2); print $2}'; }

FREE=$(pages "Pages free")
COMP_OCC=$(pages "Pages occupied by compressor")
COMP_STORED=$(pages "Pages stored in compressor")
WIRED=$(pages "Pages wired down")

FREE_GB=$(gb "$FREE")
COMP_GB=$(gb "$COMP_OCC")
STORED_GB=$(gb "$COMP_STORED")
WIRED_GB=$(gb "$WIRED")

SWAP_USED=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
SWAP_GB=$(awk -v m="$SWAP_USED" 'BEGIN{printf "%.1f", m/1024}')
LOAD=$(uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/')
UP=$(uptime | sed -E 's/.*up ([^,]+(, [0-9]+ (hour|min)[^,]*)?),.*users.*/\1/')

# Squeeze = how much data macOS is cramming into RAM beyond what fits.
SQUEEZE=$(awk -v s="$STORED_GB" -v o="$COMP_GB" 'BEGIN{if(o>0) printf "%.1f", s/o; else print "0"}')

echo "==================================================="
echo " YOUR MAC RIGHT NOW   ($(date '+%a %d %b, %H:%M'))"
echo "==================================================="
echo
echo "  Total memory installed .......... ${TOTAL_GB} GB"
echo "  Genuinely free .................. ${FREE_GB} GB"
echo "  Squashed to make room ........... ${STORED_GB} GB of data crammed into ${COMP_GB} GB"
echo "  Pushed out to disk (swap) ....... ${SWAP_GB} GB"
echo "  Reserved by macOS itself ........ ${WIRED_GB} GB"
echo "  Jobs queued for ${CORES} CPU cores ...... ${LOAD}"
echo "  Switched on for .................. ${UP}"
echo

VERDICT="HEALTHY"
WHY="Everything fits. The Mac has room to work."
if awk -v s="$SWAP_GB" 'BEGIN{exit !(s>4)}' || awk -v f="$FREE_GB" 'BEGIN{exit !(f<0.5)}'; then
  VERDICT="STRUGGLING"
  WHY="You are asking for more memory than the Mac has. It is squashing and shuffling data instead of working, which is what makes it feel slow."
elif awk -v s="$SWAP_GB" 'BEGIN{exit !(s>1)}'; then
  VERDICT="GETTING TIGHT"
  WHY="Still fine, but there is not much headroom left. Closing something now avoids the slowdown later."
fi

echo "  VERDICT: $VERDICT"
echo "  $WHY"
echo

if awk -v q="$SQUEEZE" 'BEGIN{exit !(q>2.5)}'; then
  echo "  Note: every 1 GB of RAM is holding ${SQUEEZE} GB of squashed data."
  echo "  Above about 2.5x the Mac spends more time squashing than working."
  echo
fi

echo "---------------------------------------------------"
echo " WHAT IS HOLDING THE MEMORY"
echo "---------------------------------------------------"
ps -Ao rss,args | awk '
  NR>1 {
    r=$1;
    # Match against the command only. Anchored patterns like /^\/System/ never
    # fire against the whole line, because the line starts with the RSS number.
    l=$0; sub(/^[ \t]*[0-9]+[ \t]+/, "", l);
    if (l ~ /claude-code/)                    g="Claude Code sessions";
    else if (l ~ /Claude\.app/)               g="Claude desktop app";
    else if (l ~ /chrome-headless-shell/)     g="Test browsers (Playwright)";
    else if (l ~ /Google Chrome/)             g="Google Chrome";
    else if (l ~ /Evernote/)                  g="Evernote";
    else if (l ~ /Wispr/)                     g="Wispr Flow";
    else if (l ~ /zoom\.us/)                  g="Zoom";
    else if (l ~ /Google Drive/)              g="Google Drive";
    else if (l ~ /whisper\.cpp/)              g="Whisper transcription";
    else if (l ~ /^\/System|^\/usr\/|^\/sbin/) g="macOS itself";
    else                                      g="Everything else";
    t[g]+=r; n[g]++
  }
  END { for (k in t) printf "%7.2f GB  %-28s (%d process%s)\n",
          t[k]/1048576, k, n[k], (n[k]==1 ? "" : "es") }
' | sort -rn

echo
echo "---------------------------------------------------"
echo " LEFTOVERS THAT SHOULD NOT BE RUNNING"
echo "---------------------------------------------------"

FOUND=0

# Test browsers with no test run to belong to.
if ! pgrep -f "playwright test" >/dev/null 2>&1; then
  STRAY=$(pgrep -f chrome-headless-shell 2>/dev/null | wc -l | tr -d ' ')
  if [ "$STRAY" -gt 0 ]; then
    echo "  $STRAY test browser(s) still running with no test in progress."
    FOUND=1
  fi
fi

# Preview servers whose session has gone but which survive on the desktop app.
while read -r pid port; do
  [ -z "$pid" ] && continue
  CONNS=$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | grep -c . || true)
  if [ "${CONNS:-0}" -eq 0 ]; then
    echo "  Preview server on port $port (pid $pid) has nothing connected to it."
    FOUND=1
  fi
done < <(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
         | awk '/[Pp]ython/ {split($9,a,":"); print $2, a[length(a)]}' | sort -u)

SESSIONS=$(pgrep -f "claude-code/.*claude.app" 2>/dev/null | wc -l | tr -d ' ')
SESSIONS=$((SESSIONS / 2))
if [ "$SESSIONS" -gt 3 ]; then
  echo "  $SESSIONS Claude Code sessions are open. Each one carries its own"
  echo "    helper processes. More than about 3 on a ${TOTAL_GB} GB Mac causes this slowdown."
  FOUND=1
fi

[ "$FOUND" -eq 0 ] && echo "  Nothing stale found."
echo
echo "  To clear the leftovers safely:  ./scripts/mac-guard.sh"
echo
