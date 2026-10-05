#!/usr/bin/env python3
"""Read-only checks. Commands are selected from a reviewed allowlist, never a shell."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / 'ci/policy.json').read_text())
REPORTS = Path(os.environ.get('CI_REPORT_DIR', ROOT / 'ci/reports'))
EXCLUDED = {'.git', 'node_modules', 'dist', 'build', '.dart_tool', 'Pods', '.gradle', 'reports', '__pycache__'}
TEST_DATABASE = 'terracart_inventory_isolation_test'


def safe_environment():
    # Deliberately do not inherit cloud/DB/signing credentials into test commands.
    allowed = {'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
               'LC_ALL', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
               'FLUTTER_ROOT', 'PUB_CACHE', 'NPM_CONFIG_CACHE', 'npm_config_cache'}
    env = {k: v for k, v in os.environ.items() if k in allowed}
    env.update({'CI': 'true', 'NODE_ENV': 'test',
                'MONGO_URI': f'mongodb://127.0.0.1:27017/{TEST_DATABASE}',
                'MONGO_LOCAL_FALLBACK_ENABLED': 'false', 'USE_S3': 'false',
                'BACKUP_SCHEDULER_ENABLED': 'false', 'PRINTER_ENABLED': 'false',
                'JWT_SECRET': 'ci-isolated-test-only', 'PORT': '0',
                'MONGOMS_DISABLE_POSTINSTALL': '1'})
    return env


def run(args, *, env=None, capture=False):
    result = subprocess.run(args, cwd=ROOT, env=env or safe_environment(),
                            text=True, capture_output=capture, check=False)
    if not capture and result.returncode:
        raise RuntimeError(f'{args[0]} check failed (exit {result.returncode})')
    return result


def report(name, data):
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / name).write_text(json.dumps(data, indent=2) + '\n')


def source_files():
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True)
    paths = [ROOT / x.decode() for x in result.stdout.split(b'\0') if x]
    if result.returncode:
        paths = list(ROOT.rglob('*'))
    return [p for p in paths if p.is_file() and not p.is_symlink()
            and not any(x in EXCLUDED for x in p.relative_to(ROOT).parts)
            and p.stat().st_size < 2_000_000]


def preflight():
    if POLICY['kind'] != 'flutter':
        pkg = json.loads((ROOT / 'package.json').read_text())
        if not (ROOT / 'package-lock.json').is_file():
            raise RuntimeError('Lockfile is required')
        for name, expected in POLICY['reviewed_scripts'].items():
            if pkg.get('scripts', {}).get(name) != expected:
                raise RuntimeError(f'Package script {name} changed; review before allowing CI execution')
        for hook in ['preinstall', 'install', 'postinstall', 'prepare',
                     'prelint', 'postlint', 'prebuild', 'postbuild', 'pretest', 'posttest',
                     'pretest:run', 'posttest:run']:
            if pkg.get('scripts', {}).get(hook):
                raise RuntimeError(f'Unreviewed package lifecycle hook: {hook}')
        version = run(['node', '--version'], capture=True).stdout.strip().lstrip('v')
        if version != POLICY['node']:
            raise RuntimeError(f'Node {POLICY["node"]} is required for reproducible CI')
    else:
        if not (ROOT / 'pubspec.lock').is_file():
            raise RuntimeError('Flutter lockfile is required')
        version = json.loads(run(['flutter', '--version', '--machine'], capture=True).stdout)
        if version['frameworkVersion'] != POLICY['flutter']:
            raise RuntimeError('Pinned Flutter version mismatch')
        for path in [ROOT / 'android/key.properties', *ROOT.glob('android/**/*.jks'),
                     *ROOT.glob('android/**/*.keystore')]:
            if path.exists():
                raise RuntimeError('Production signing material must not be present in PR CI')
    for path in ROOT.glob('.env*'):
        if path.name.endswith('.example'):
            continue
        if POLICY['kind'] == 'flutter' and path.name == '.env':
            if path.read_text() == 'API_ORIGIN=http://127.0.0.1:9\n':
                continue
        raise RuntimeError('Real environment files are forbidden in CI; use isolated public configuration')
    print('DATABASE ENVIRONMENT: TEST; TARGET: loopback / ' + TEST_DATABASE)
    print('No production DB/cloud/signing credentials are passed to check commands.')


def dangerous_operations():
    rules = {
        'database-drop': r'dropDatabase|\bDROP\s+(?:DATABASE|TABLE)\b|\.drop\s*\(',
        'data-removal': r'deleteMany|remove\s*\(\s*\{\s*\}|\bTRUNCATE\b',
        'reset-or-index-migration': r'migrate\s+reset|db:drop|schema:drop|syncIndexes',
        'filesystem-removal': r'rm\s+-rf|rsync[^\n]*--delete|find[^\n]*-delete|git\s+clean\s+-fdx',
        'filesystem-api-removal': r'\bfs\.(?:rm|unlink|rmSync|unlinkSync)\s*\(',
        'seeder': r'\bseed(?:er|ing)?\b|seed-inventory|seedMenu|seedCosting',
    }
    hits = []
    for path in source_files():
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith(('ci/', '.github/')):
            continue
        for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            for name, pattern in rules.items():
                if re.search(pattern, line, re.I):
                    level = ('SAFE TEST-ONLY' if relative in POLICY.get('safe_tests', [])
                             or relative == 'tests/helpers/isolatedMongo.js'
                             else 'PRODUCTION DANGEROUS' if relative.startswith('scripts/')
                             else 'POTENTIALLY DANGEROUS')
                    hits.append({'path': relative, 'line': number, 'rule': name, 'classification': level})
    # Record locations/rules only, never source lines or discovered secrets.
    report('dangerous-operations.json', hits)
    print(f'{len(hits)} dangerous-operation locations reported; none executed by this audit.')


def secret_scan():
    patterns = {
        'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        'aws-access-key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
        'github-token': r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b',
        'database-credentials': r'mongodb(?:\+srv)?://[^\s"\x27/]+:[^\s"\x27/@]+@',
        'service-account-key': r'"private_key"\s*:\s*"[^"\n]*BEGIN',
    }
    hits = []
    for path in source_files():
        relative = path.relative_to(ROOT).as_posix()
        if path.name.startswith('.env') and not path.name.endswith('.example'):
            if not (POLICY['kind'] == 'flutter' and path.name == '.env' and path.read_text() == 'API_ORIGIN=http://127.0.0.1:9\n'):
                hits.append({'path': relative, 'line': 1, 'rule': 'committed-environment-file'})
        if path.suffix in {'.jks', '.keystore'} or path.name == 'key.properties':
            hits.append({'path': relative, 'line': 1, 'rule': 'committed-signing-material'})
        for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            for name, pattern in patterns.items():
                if re.search(pattern, line) and not re.search(r'fixture|example|YOUR_|placeholder|test-only', line, re.I):
                    hits.append({'path': relative, 'line': number, 'rule': name})
    report('secret-scan.json', hits)
    print(f'Secret scan: {len(hits)} findings; locations only, values never printed.')
    if hits:
        raise RuntimeError('Committed secret/environment findings block CI; manual remediation required')


def lint():
    if POLICY['kind'] == 'backend':
        print('Backend lint/typecheck are not configured; validating syntax without starting the server.')
        for path in source_files():
            if path.suffix in {'.js', '.mjs', '.cjs'}:
                run(['node', '--check', str(path)])
        run(['npm', 'run', 'build', '--ignore-scripts'])
    elif POLICY['kind'] == 'flutter':
        run(['dart', 'format', '--output=none', '--set-exit-if-changed', 'lib', 'test'])
        run(['flutter', 'analyze', '--no-pub'])
    else:
        result = run(['npm', 'run', 'lint', '--ignore-scripts', '--', '--format', 'json'], capture=True)
        start = result.stdout.find('[{"filePath"')
        if start < 0:
            raise RuntimeError('ESLint failed without a usable JSON report')
        rows = json.loads(result.stdout[start:])
        findings = [{'path': os.path.relpath(row['filePath'], ROOT), 'rule': msg['ruleId'],
                     'severity': msg['severity'], 'line': msg['line'], 'message': msg['message']}
                    for row in rows for msg in row['messages']]
        report('lint.json', findings)
        print(f'ESLint: {sum(x["severity"] == 2 for x in findings)} errors, '
              f'{sum(x["severity"] == 1 for x in findings)} warnings')
        if result.returncode:
            raise RuntimeError('Existing or new ESLint failures block CI; source is not modified')


def tests():
    env = safe_environment()
    if POLICY['kind'] == 'backend':
        run(['node', '--require', str(ROOT / 'ci/db-guard.cjs'), '--test', *POLICY['safe_tests']], env=env)
    elif POLICY['kind'] == 'flutter':
        for name in POLICY.get('test_output_directories', []):
            path = Path(name)
            if path.is_absolute() or '..' in path.parts or path.parts[0] != 'build':
                raise RuntimeError('Test output directories must remain below local build/')
            (ROOT / path).mkdir(parents=True, exist_ok=True)
        run(['flutter', 'test', '--no-pub', '--reporter', 'expanded'])
    elif POLICY.get('test_script'):
        run(['npm', 'run', POLICY['test_script'], '--ignore-scripts'])
    else:
        print('No customer-web test framework/script exists; no fake test command is added.')


def security():
    dangerous_operations()
    secret_scan()
    if POLICY['kind'] != 'flutter':
        result = run(['npm', 'audit', '--audit-level=high', '--json'], capture=True)
        data = json.loads(result.stdout)
        if data.get('error') or 'metadata' not in data:
            raise RuntimeError('Dependency audit could not complete; no pass is inferred')
        counts = data['metadata']['vulnerabilities']
        report('dependency-audit.json', {'vulnerabilities': counts, 'packages': [
            {'name': name, 'severity': finding.get('severity'),
             'direct': finding.get('isDirect'), 'range': finding.get('range'),
             'fix_available': bool(finding.get('fixAvailable'))}
            for name, finding in data.get('vulnerabilities', {}).items()]})
        print('Dependency vulnerability counts: ' + json.dumps(counts))
        if result.returncode:
            raise RuntimeError('Dependency audit blocks CI at high/critical severity; no automatic fix is run')


def build():
    from artifact import package_build
    package_build(ROOT, POLICY, run)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('check', choices=['preflight', 'lint', 'test', 'security', 'build', 'dangerous-operations', 'secrets'])
    action = parser.parse_args().check
    try:
        {'preflight': preflight, 'lint': lint, 'test': tests, 'security': security,
         'build': build, 'dangerous-operations': dangerous_operations, 'secrets': secret_scan}[action]()
    except Exception as error:
        print(f'CI STOPPED: {error}', file=sys.stderr)
        sys.exit(1)
