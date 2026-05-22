#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-http://100.66.1.82:3333}"
OUT_DIR="android/evidence/daemon-mirror/$(date +%Y-%m-%d-%H%M%S)-runtime-collect"
mkdir -p "$OUT_DIR"
python3 - <<'PY'
import requests,time,json,math,datetime,os
B=os.environ.get('BASE_URL','http://100.66.1.82:3333')
requests.get(f'{B}/debug/runtime/control?enabled=1',timeout=5)
rows=[]
for i in range(120):
  h=requests.get(f'{B}/health',timeout=5).json()
  logs=requests.get(f'{B}/debug/runtime/logs?limit=8000',timeout=8).json().get('logs',[])
  sc={}
  for e in logs: sc[e.get('scope','')]=sc.get(e.get('scope',''),0)+1
  rec={'ts':datetime.datetime.now().isoformat(),'attached':h.get('sessions',{}).get('attached',0),'send':sc.get('session.input.send',0),'applied':sc.get('session.buffer.applied',0),'logCount':len(logs)}
  rows.append(rec)
  if rec['send']>=30 and rec['applied']>0:
    break
  time.sleep(1)
print(json.dumps(rows[-1],ensure_ascii=False))
PY
