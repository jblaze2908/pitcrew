#!/bin/bash
# One computer per crew member: boots two hardened bot computers side by side and proves they are separate.
set -uo pipefail
cd "$(dirname "$0")"
pass=0; fail=0
ok() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
boot() {  # boot <bot> <network> <live-port>
  docker network inspect "pc-net-$1" >/dev/null 2>&1 || docker network create "pc-net-$1" >/dev/null
  local net=$2; [ "$net" = own ] && net="pc-net-$1"
  docker run -d --name "pc-bot-$1" --hostname "$1" --cpus 1 --memory 1g --pids-limit 512 --shm-size 512m \
    --read-only --tmpfs /tmp:size=256m,mode=1777 --tmpfs /home/probe:size=64m,uid=1500,gid=1500,mode=700 \
    --cap-drop ALL --security-opt no-new-privileges --network "$net" -p "127.0.0.1:$3:6080" \
    -v "pc-profile-$1:/bot" pitcrew-bot:0.1 >/dev/null
}
ready_ms() { local s=$1 b=$2; for i in $(seq 1 150); do docker logs "pc-bot-$b" 2>/dev/null | grep -q desktop-ready && { echo $(( $(date +%s%3N) - s )); return; }; sleep 0.2; done; echo timeout; }

docker rm -f pc-bot-bills pc-bot-inbox >/dev/null 2>&1
docker volume rm pc-profile-bills pc-profile-inbox >/dev/null 2>&1
s=$(date +%s%3N); boot bills own 6101; boot inbox none 6102
echo "boot to desktop-ready: bills $(ready_ms $s bills) ms, inbox $(ready_ms $s inbox) ms (booted together)"
sleep 3
docker stats --no-stream --format "idle  {{.Name}}  mem {{.MemUsage}}  cpu {{.CPUPerc}}  pids {{.PIDs}}" pc-bot-bills pc-bot-inbox

docker exec pc-bot-bills sh -c 'echo "bescom consumer 7810" > /bot/bills-only.txt'
ok "each bot has its own disk (inbox can't see bills' file)" '! docker exec pc-bot-inbox test -e /bot/bills-only.txt'
ok "each bot has its own browser profile" '[ "$(docker exec pc-bot-bills ls /bot/profile | wc -l)" -gt 0 ] && [ "$(docker volume inspect -f "{{.Mountpoint}}" pc-profile-bills)" != "$(docker volume inspect -f "{{.Mountpoint}}" pc-profile-inbox)" ]'
ok "bills (own network) can reach the internet" 'docker exec pc-bot-bills node -e "fetch(\"https://httpbin.org/get\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'
ok "inbox (egress policy: none) cannot reach the internet" '! docker exec pc-bot-inbox node -e "fetch(\"https://httpbin.org/get\",{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))"'
ok "bots cannot reach each other" '! docker exec pc-bot-bills node -e "fetch(\"http://inbox:6080\",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))"'
ok "no capabilities, no privilege escalation, non-root" '[ "$(docker exec pc-bot-inbox sh -c "id -u; grep CapEff /proc/self/status | cut -f2; grep NoNewPrivs /proc/self/status | cut -f2" | tr "\n" " ")" = "1500 0000000000000000 1 " ]'
ok "root filesystem is read-only" '! docker exec pc-bot-inbox touch /usr/local/bin/x 2>/dev/null'
ok "memory cap is enforced (1 GiB)" '[ "$(docker inspect -f "{{.HostConfig.Memory}}" pc-bot-inbox)" = 1073741824 ]'
docker kill pc-bot-bills >/dev/null
ok "killing bills leaves inbox's desktop running" 'docker exec pc-bot-inbox import -window root /tmp/after-kill.png'
ok "bills' profile survives its computer being killed" 'docker run --rm -v pc-profile-bills:/bot pitcrew-bot:0.1 true >/dev/null 2>&1; docker run --rm --entrypoint cat -v pc-profile-bills:/bot pitcrew-bot:0.1 /bot/bills-only.txt | grep -q 7810'
docker rm -f pc-bot-bills pc-bot-inbox >/dev/null 2>&1
echo "isolation: $pass passed, $fail failed"
