from pathlib import Path
p=Path('.research/probe.mjs');s=p.read_text().replace("console.log(JSON.stringify({count:n,result:m}));", "console.log(JSON.stringify({count:n,agents:m.result?.config?.agents,features:m.result?.config?.features?.multi_agent,v2:m.result?.config?.features?.multi_agent_v2,error:m.error}));")
p.write_text(s)
