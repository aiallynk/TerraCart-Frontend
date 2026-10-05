#!/usr/bin/env python3
"""Build/verify immutable artifacts without copying environments or persistent data."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
from urllib.parse import urlsplit


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def assert_public_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in {'', '/'}):
        raise ValueError('Public production API origin must be HTTPS, without credentials/path/query')
    if parsed.hostname in {'localhost', '127.0.0.1', '::1'} or parsed.hostname.endswith('.invalid'):
        raise ValueError('Production API origin cannot be a local/test address')
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise ValueError('Production API origin cannot be a private/test IP address')
    return value.rstrip('/')


def write_manifest(directory, *, kind, repository, commit, environment, public_config=None):
    directory = Path(directory)
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('A full commit SHA is required')
    files = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('Artifact symlinks are forbidden')
        if not path.is_file():
            continue
        relative = path.relative_to(directory).as_posix()
        if path.name.startswith('.env') or path.suffix in {'.jks', '.keystore', '.pem'}:
            raise ValueError('Environment/signing files cannot enter an artifact')
        files[relative] = digest(path)
    manifest = {'schema': 1, 'kind': kind, 'repository': repository, 'commit': commit,
                'environment': environment, 'run_id': os.environ.get('GITHUB_RUN_ID', 'local'),
                'public_config': public_config or {}, 'files': files}
    (directory / 'artifact-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def verify(directory, expected_repository, expected_commit, expected_kind=None, *, expected_environment='production'):
    directory = Path(directory)
    if directory.is_symlink() or any(p.is_symlink() for p in directory.rglob('*')):
        raise ValueError('Artifact symlinks are forbidden')
    manifest = json.loads((directory / 'artifact-manifest.json').read_text())
    if (manifest.get('schema') != 1 or manifest.get('repository') != expected_repository
            or manifest.get('commit') != expected_commit or manifest.get('environment') != expected_environment
            or (expected_kind and manifest.get('kind') != expected_kind)):
        raise ValueError('Artifact provenance/environment mismatch')
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()}
    if actual != set(manifest['files']) | {'artifact-manifest.json'}:
        raise ValueError('Artifact contains unexpected or missing files')
    for name, checksum in manifest['files'].items():
        path = directory / name
        if (PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts
                or path.is_symlink() or not re.fullmatch(r'[a-f0-9]{64}', checksum)
                or digest(path) != checksum):
            raise ValueError('Artifact file integrity check failed')
    return manifest


def archive(directory, destination):
    with tarfile.open(destination, 'w:gz') as output:
        for path in sorted(Path(directory).rglob('*')):
            if path.is_symlink():
                raise ValueError('Archive symlinks are forbidden')
            output.add(path, arcname=path.relative_to(directory).as_posix(), recursive=False)


def extract(archive_path, destination):
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError('Artifact destination symlinks are forbidden')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Artifact destination must be new/empty')
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, 'r:gz') as package:
        members = package.getmembers()
        if len(members) > 30000 or sum(x.size for x in members) > 2_000_000_000:
            raise ValueError('Artifact size/member limit exceeded')
        seen = set()
        for item in members:
            name = PurePosixPath(item.name)
            if (name.is_absolute() or '..' in name.parts or item.name in seen
                    or not (item.isfile() or item.isdir())):
                raise ValueError('Unsafe archive member')
            seen.add(item.name)
        # Members are regular files/directories only, so archive links cannot escape.
        for item in members:
            target = destination / item.name
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)


def verify_runtime_imports(directory):
    """Trace literal local imports from server.js without importing application code."""
    directory = Path(directory).resolve()
    pending = [directory / 'server.js']
    visited = set()
    while pending:
        module = pending.pop()
        if module in visited or module.suffix not in {'.js', '.cjs', '.mjs'}:
            continue
        visited.add(module)
        for name in re.findall(r'\brequire\s*\(\s*[\"\x27]([^\"\x27]+)[\"\x27]\s*\)', module.read_text()):
            if not name.startswith('.'):
                continue
            target = (module.parent / name).resolve()
            if directory not in target.parents:
                raise ValueError('Runtime import escapes application artifact')
            candidates = [target, *(Path(str(target) + suffix) for suffix in ['.js', '.json', '.node']),
                          *(target / ('index' + suffix) for suffix in ['.js', '.json', '.node'])]
            resolved = next((path for path in candidates if path.is_file()), None)
            if not resolved:
                raise ValueError(f'Artifact missing literal runtime dependency: {target.relative_to(directory)}')
            pending.append(resolved)


def package_build(root, policy, run):
    root = Path(root)
    output = Path(os.environ.get('CI_ARTIFACT_DIR', root / 'ci/artifacts'))
    output.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='terracart-artifact-', dir=os.environ.get('RUNNER_TEMP')))
    payload = temporary / 'payload'
    payload.mkdir()
    production = os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
    public = {}
    if policy['kind'] == 'backend':
        # Explicit runtime allowlist excludes scripts, APKs, backups, uploads, .env,
        # tests and app-update.json. Existing server-owned state is linked on server.
        for name in policy['runtime_paths']:
            source = root / name
            if not source.exists():
                raise ValueError(f'Required backend runtime path missing: {name}')
            if source.is_dir():
                shutil.copytree(source, payload / name, symlinks=True)
            else:
                shutil.copy2(source, payload / name)
        verify_runtime_imports(payload)
    elif policy['kind'] == 'web':
        origin = assert_public_origin(os.environ.get('PRODUCTION_API_ORIGIN', '')) if production else 'http://127.0.0.1:9'
        customer = assert_public_origin(os.environ.get('PRODUCTION_CUSTOMER_ORIGIN', '')) if production and policy.get('test_script') else 'http://127.0.0.1:9'
        fallback = assert_public_origin(os.environ.get('PRODUCTION_FALLBACK_API_ORIGIN', '')) if production else 'http://127.0.0.1:9'
        # This environment is public bundle configuration, never a secret.
        from checks import safe_environment
        env = safe_environment()
        public = {'VITE_NODE_API_URL': origin, 'VITE_PRIMARY_API_URL': origin,
                  'VITE_FALLBACK_API_URL': fallback, 'VITE_USE_VITE_PROXY': 'false'}
        if policy.get('test_script'):
            public['VITE_CUSTOMER_BASE_URL'] = customer
            public['VITE_FEATURE_COSTING_ENABLED'] = os.environ.get('PUBLIC_FEATURE_COSTING_ENABLED', '') if production else 'false'
            if public['VITE_FEATURE_COSTING_ENABLED'] not in {'true', 'false'}:
                raise ValueError('Existing production costing flag must be explicitly configured')
        env.update(public)
        static = payload / '.vercel/output/static'
        static.mkdir(parents=True)
        # Fresh temporary target; existing tracked dist files are never touched.
        run(['npm', 'run', 'build', '--ignore-scripts', '--', '--mode', 'ci', '--outDir', str(static)], env=env)
        if not (static / 'index.html').is_file() or not list(static.glob('assets/*.js')):
            raise ValueError('Static HTML/JavaScript artifact missing')
        (payload / '.vercel/output/config.json').write_text(json.dumps({'version': 3, 'routes': [
            {'src': '/assets/(.*)', 'headers': {'Cache-Control': 'public, max-age=31536000, immutable'}, 'continue': True},
            {'handle': 'filesystem'}, {'src': '/(.*)', 'dest': '/index.html'}]}, indent=2) + '\n')
    else:
        public = {'build_type': 'debug', 'USE_PROD_API': False, 'API_ORIGIN': 'http://127.0.0.1:9'}
        run(['flutter', 'build', 'apk', '--debug', '--no-pub', '--dart-define=USE_PROD_API=false'])
        apk = root / 'build/app/outputs/flutter-apk/app-debug.apk'
        if not apk.is_file() or apk.stat().st_size == 0:
            raise ValueError('Debug validation APK missing')
        shutil.copy2(apk, payload / 'validation-debug.apk')
    write_manifest(payload, kind=policy['kind'], repository=policy['repository'],
                   commit=os.environ.get('GITHUB_SHA', ''), environment=('validation' if policy['kind'] == 'flutter' else 'production' if production else 'test'), public_config=public)
    archive(payload, output / 'artifact.tar.gz')
    (output / 'artifact.tar.gz.sha256').write_text(digest(output / 'artifact.tar.gz') + '\n')
    print(f'Built immutable {policy["kind"]} artifact; no deployment performed.')
