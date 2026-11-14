#!/usr/bin/env python3
"""Constrói e verifica imagens novas do MangaCloud sem atualizar stack existente."""
from pathlib import Path
import json
import secrets
import subprocess
import sys
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[2]
token = secrets.token_hex(6)
images = {}
out = root / 'docs/qa/evidencias'
out.mkdir(exist_ok=True)
report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'status': 'EM_EXECUCAO', 'images': images}
(out / 'build-images.json').write_text(json.dumps(report, indent=2) + '\n')
checks = {
    'app': "const fs=require('fs'); for(const p of ['/app/db/002_dominio_mangacloud.sql','/app/db/004_identidade_cobranca.sql','/app/backend/dist/migrations/migrate.js','/app/frontend/dist/index.html'])if(!fs.existsSync(p))throw Error(p);const {createApp}=require('./dist/app');const server=createApp().listen(0,'127.0.0.1',async()=>{try{const base='http://127.0.0.1:'+server.address().port;const r=await fetch(base+'/api/mangas?provider=demo');const d=await r.json();if(!r.ok||d.items.length<3)throw Error('Demo');const html=await(await fetch(base)).text();if(!html.includes('MangaCloud'))throw Error('SPA');console.log('Imagem: frontend, Demo, OpenAPI e migrations presentes.');server.close();}catch(e){console.error(e);process.exitCode=1;server.close();}})",
    'auth': "const {createAuthApp}=require('./dist/server');createAuthApp();console.log('Imagem auth: JavaScript e OpenAPI carregados.');",
    'logs': "const {createLogApp}=require('./dist/server');createLogApp();console.log('Imagem logs: JavaScript carregado.');",
}
try:
    for service, context in [('app', '.'), ('auth', 'auth-service'), ('logs', 'log-service')]:
        image = f'mangacloud-qa-{service}:{token}'
        print(f'[BUILD QA] {image}', flush=True)
        subprocess.run(['docker', 'build', '--pull=false', '--build-arg', 'NPM_CONFIG_FETCH_RETRIES=0', '--build-arg', 'NPM_CONFIG_FETCH_TIMEOUT=20000', '--label', 'mangacloud.qa.build=true', '--tag', image, context], cwd=root, check=True, timeout=240)
        subprocess.run(['docker', 'run', '--pull=never', '--rm', '--network=none', '--memory', '1g', '--name', f'mangacloud-qa-image-{service}-{token}', '--label', 'mangacloud.qa.build=true', '--env', 'INTERNAL_SERVICE_TOKEN=qa-local-fixture', '--entrypoint', 'node', image, '-e', checks[service]], cwd=root, check=True, timeout=30)
        images[service] = image
    report['status'] = 'APROVADO'
    print('[BUILD QA] As três imagens foram construídas e verificadas; stack existente preservada.', flush=True)
except subprocess.TimeoutExpired:
    report['status'] = 'FALHOU'
    report['reason'] = 'timeout'
    print('[BUILD QA] Prazo excedido; não há aprovação de imagem para esta execução.', file=sys.stderr)
    sys.exit(1)
except subprocess.CalledProcessError as error:
    report['status'] = 'FALHOU'
    report['reason'] = f'exit-code-{error.returncode}'
    print(f'[BUILD QA] Etapa falhou (código {error.returncode}); nenhuma stack foi atualizada.', file=sys.stderr)
    sys.exit(1)
finally:
    (out / 'build-images.json').write_text(json.dumps(report, indent=2) + '\n')
