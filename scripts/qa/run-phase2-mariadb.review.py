#!/usr/bin/env python3
"""Revisão MariaDB isolada: python3 scripts/qa/run-phase2-mariadb.review.py.

Somente usa um container recém-criado, sem mounts de host/volumes do projeto.
Não lista, reutiliza ou remove containers de outras aplicações.
"""
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.request


def docker(*args, timeout=15, check=True):
    return subprocess.run(
        ["docker", *args], text=True, capture_output=True, timeout=timeout, check=check
    )


def main():
    root = Path(__file__).resolve().parents[2]
    allowed = {'--api', '--browser', '--mangadex-live', '--public-dns', '--stripe-live', '--stripe-clocks'}
    if any(argument not in allowed for argument in sys.argv[1:]):
        raise RuntimeError('Opção de QA desconhecida.')
    if '--public-dns' in sys.argv and '--mangadex-live' not in sys.argv:
        raise RuntimeError('--public-dns exige --mangadex-live explícito.')
    if '--stripe-clocks' in sys.argv and '--stripe-live' not in sys.argv:
        raise RuntimeError('--stripe-clocks exige --stripe-live explícito.')
    api_tests = any(argument in sys.argv for argument in ('--api', '--browser', '--mangadex-live', '--stripe-live'))
    token = secrets.token_hex(12)
    password = secrets.token_hex(24)
    name = f"mangacloud-qa-review-{token}"
    label = "mangacloud.qa.review"
    container_id = None
    minio_id = None
    redis_id = None
    result_code = 1
    try:
        # --pull=never: não baixa imagem nem acessa outros serviços.
        created = docker(
            "run", "--pull=never", "--rm", "--detach", "--name", name,
            "--label", f"{label}={token}", "--memory", "1g", "--cpus", "1",
            "--publish", "127.0.0.1::3306",
            "--tmpfs", "/var/lib/mysql:rw,nosuid,size=512m",
            "--env", f"MARIADB_ROOT_PASSWORD={password}",
            "--env", "MARIADB_ROOT_HOST=%", "mariadb:11.8", timeout=30
        )
        container_id = created.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{64}", container_id):
            raise RuntimeError("ID inesperado na criação do container de QA")
        actual_label = docker(
            "inspect", "--format", '{{ index .Config.Labels "mangacloud.qa.review" }}', container_id
        ).stdout.strip()
        if actual_label != token:
            raise RuntimeError("Identidade do container de QA não confere")
        published = docker("port", container_id, "3306/tcp").stdout.strip()
        match = re.fullmatch(r"127\.0\.0\.1:(\d+)", published)
        if not match:
            raise RuntimeError("Porta do QA não está exclusivamente em loopback")
        port = match.group(1)
        print(f"[QA] Container exclusivo {name}; MariaDB somente em 127.0.0.1:{port}", flush=True)

        deadline = time.monotonic() + 55
        while True:
            ready = docker(
                "exec", container_id, "mariadb", "--protocol=tcp", "--host=127.0.0.1",
                "--port=3306", "--user=root", f"--password={password}",
                "--connect-timeout=2", "--skip-column-names", "--execute=SELECT VERSION();",
                check=False, timeout=5
            )
            if ready.returncode == 0:
                version = ready.stdout.strip()
                if not version.startswith("11.8") or "MariaDB" not in version:
                    raise RuntimeError("Versão de banco diferente do alvo MariaDB 11.8")
                print(f"[QA] Banco pronto: {version}", flush=True)
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("MariaDB de QA não ficou pronto no prazo")
            time.sleep(0.5)

        # Configuração explícita: não utiliza credenciais reais herdadas pelo shell.
        env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ}
        env.update({
            "DOTENV_CONFIG_QUIET": "true",
            "QA_DB_HOST": "127.0.0.1", "QA_DB_PORT": port,
            "QA_DB_USER": "root", "QA_DB_PASSWORD": password,
            "DB_HOST": "127.0.0.1", "DB_PORT": port,
            "DB_USER": "root", "DB_PASSWORD": password, "DB_NAME": "mangacloud_qa_clean",
            "INTERNAL_SERVICE_TOKEN": secrets.token_hex(32), "JWT_SECRET": secrets.token_hex(32),
            "QA_MARIADB_INTEGRATION": "1", "MIGRATE_SIMULATE_FAILURE": "",
        })
        for role in ("LEITOR", "CURADOR", "ADMIN"):
            env[f"QA_{role}_EMAIL"] = ""
            env[f"QA_{role}_PASSWORD"] = ""
        if api_tests:
            minio_id = docker(
                'run', '--pull=never', '--rm', '--detach', '--name', f'mangacloud-qa-minio-{token}',
                '--label', f'{label}={token}', '--memory', '1g', '--cpus', '1',
                '--publish', '127.0.0.1::9000', '--tmpfs', '/data:rw,nosuid,size=128m',
                '--env', 'MINIO_ROOT_USER=mangacloudqa', '--env', f'MINIO_ROOT_PASSWORD={password}',
                'elestio/minio:latest', 'server', '/data', timeout=30
            ).stdout.strip()
            if not re.fullmatch(r'[0-9a-f]{64}', minio_id):
                raise RuntimeError('ID inesperado para MinIO QA')
            minio_label = docker('inspect', '--format', '{{ index .Config.Labels "mangacloud.qa.review" }}', minio_id).stdout.strip()
            if minio_label != token:
                raise RuntimeError('Identidade MinIO QA inválida')
            mapped = docker('port', minio_id, '9000/tcp').stdout.strip()
            minio_match = re.fullmatch(r'127\.0\.0\.1:(\d+)', mapped)
            if not minio_match:
                raise RuntimeError('Porta MinIO QA inválida')
            minio_port = minio_match.group(1)
            ready_deadline = time.monotonic() + 45
            while True:
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{minio_port}/minio/health/ready', timeout=2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    if time.monotonic() >= ready_deadline:
                        raise RuntimeError('MinIO QA não ficou pronto no prazo')
                    time.sleep(0.5)
            env.update({
                'QA_EPHEMERAL_INSTANCE': token, 'MINIO_ENDPOINT': '127.0.0.1', 'MINIO_PORT': minio_port,
                'MINIO_SSL': 'false', 'MINIO_REGION': 'us-east-1', 'MINIO_ROOT_USER': 'mangacloudqa', 'MINIO_ROOT_PASSWORD': password,
                'LOG_SERVICE_URL': 'http://127.0.0.1:9', 'APP_URL': 'http://127.0.0.1',
            })
            print('[QA] MinIO exclusivo pronto; buckets privados serão verificados por HTTP.', flush=True)
            redis_id = docker(
                'run', '--pull=never', '--rm', '--detach', '--name', f'mangacloud-qa-redis-{token}',
                '--label', f'{label}={token}', '--memory', '1g', '--publish', '127.0.0.1::6379',
                'redis:7-alpine', 'redis-server', '--requirepass', password, timeout=30
            ).stdout.strip()
            if not re.fullmatch(r'[0-9a-f]{64}', redis_id):
                raise RuntimeError('ID inesperado para Redis QA')
            redis_label = docker('inspect', '--format', '{{ index .Config.Labels "mangacloud.qa.review" }}', redis_id).stdout.strip()
            if redis_label != token:
                raise RuntimeError('Identidade Redis QA inválida')
            redis_mapping = docker('port', redis_id, '6379/tcp').stdout.strip()
            redis_match = re.fullmatch(r'127\.0\.0\.1:(\d+)', redis_mapping)
            if not redis_match:
                raise RuntimeError('Porta Redis QA inválida')
            env['REDIS_URL'] = f'redis://:{password}@127.0.0.1:{redis_match.group(1)}'
            env['AUDIT_STREAM_MAXLEN'] = '1000'
            ready_redis = docker('exec', redis_id, 'redis-cli', '--no-auth-warning', '-a', password, 'ping')
            if 'PONG' not in ready_redis.stdout:
                raise RuntimeError('Redis QA não respondeu')
            curl_check = docker('exec', minio_id, 'sh', '-c', 'command -v curl', check=False)
            print(f'[QA] Redis exclusivo pronto; curl no MinIO: {curl_check.returncode == 0}.', flush=True)

        if any(argument in sys.argv for argument in ('--browser', '--mangadex-live', '--stripe-live')):
            env['QA_BROWSER_TESTS'] = '1'
        if '--stripe-live' in sys.argv:
            env['QA_STRIPE_LIVE'] = '1'
            env['QA_STRIPE_CLOCKS'] = '1' if '--stripe-clocks' in sys.argv else '0'
        if '--mangadex-live' in sys.argv:
            env['QA_MANGADEX_LIVE'] = '1'
            env['QA_MANGADEX_PUBLIC_DNS'] = '1' if '--public-dns' in sys.argv else '0'
        result = subprocess.run(
            ["node", "--import", "tsx", "src/migrations/verifyPhase2Db.ts", "--integration"],
            cwd=root / "backend", env=env, timeout=120
        )
        result_code = result.returncode
        if result_code == 0 and api_tests:
            result_code = subprocess.run(
                ['node', str(root / 'tests/qa/phase2-api.integration.cjs')],
                cwd=root, env=env, timeout=600 if '--stripe-live' in sys.argv else 300 if '--mangadex-live' in sys.argv or '--browser' in sys.argv else 180
            ).returncode
    finally:
        if redis_id:
            stopped_redis = docker('stop', '--time', '3', redis_id, timeout=15, check=False)
            if stopped_redis.returncode != 0 and 'no such' not in stopped_redis.stderr.lower():
                print('[QA] Falha ao parar Redis QA.', file=sys.stderr)
                result_code = 1
            else:
                removal_deadline = time.monotonic() + 5
                while docker('inspect', '--format', '{{.Id}}', redis_id, check=False).returncode == 0:
                    if time.monotonic() >= removal_deadline:
                        result_code = 1
                        break
                    time.sleep(0.25)
                else:
                    print('[QA] Redis QA removido.', flush=True)
        if minio_id:
            stopped_minio = docker('stop', '--time', '3', minio_id, timeout=15, check=False)
            if stopped_minio.returncode != 0 and 'no such' not in stopped_minio.stderr.lower():
                print('[QA] Falha ao parar MinIO QA.', file=sys.stderr)
                result_code = 1
            else:
                removal_deadline = time.monotonic() + 5
                while docker('inspect', '--format', '{{.Id}}', minio_id, check=False).returncode == 0:
                    if time.monotonic() >= removal_deadline:
                        print('[QA] Não foi possível confirmar remoção MinIO QA.', file=sys.stderr)
                        result_code = 1
                        break
                    time.sleep(0.25)
                else:
                    print('[QA] MinIO QA removido.', flush=True)
        if container_id:
            # Nunca usa nomes/padrões genéricos para limpeza.
            stopped = docker("stop", "--time", "3", container_id, timeout=15, check=False)
            if stopped.returncode != 0:
                raise RuntimeError(f"Falha ao encerrar container exclusivo de QA: {name}")
            cleanup_deadline = time.monotonic() + 5
            while True:
                removed = docker("inspect", "--format", "{{.Id}}", container_id, check=False)
                if removed.returncode != 0 and "no such" in removed.stderr.lower():
                    break
                if time.monotonic() >= cleanup_deadline:
                    raise RuntimeError(f"Não foi possível confirmar remoção do container de QA: {name}")
                time.sleep(0.25)
            print("[QA] Container descartável removido; nenhuma aplicação existente foi alterada.", flush=True)
    return result_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        # Não imprimir argumentos do Docker que contêm senha efêmera.
        print(f"[QA] Comando Docker falhou (código {error.returncode}).", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("[QA] Uma operação excedeu o prazo de execução.", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f"[QA] {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
