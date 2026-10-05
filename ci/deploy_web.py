#!/usr/bin/env python3
"""Deploy a verified static artifact to the existing Vercel project, with rollback."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen
from artifact import assert_public_origin, verify, digest
from github import environment_guard, download, activation_guard


def vercel_api(path):
    token = os.environ.get('VERCEL_TOKEN', '')
    if not token:
        raise ValueError('Protected Vercel token required')
    request = Request('https://api.vercel.com' + path, headers={'Authorization': 'Bearer ' + token})
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except Exception:
        raise ValueError('Vercel target metadata could not be verified') from None


def target():
    project = os.environ.get('VERCEL_PROJECT_ID', '')
    team = os.environ.get('VERCEL_ORG_ID', '')
    if not re.fullmatch(r'prj_[A-Za-z0-9]+', project) or not re.fullmatch(r'(?:team_)?[A-Za-z0-9]+', team):
        raise ValueError('Existing Vercel project and owner IDs are required')
    suffix = '?' + urlencode({'teamId': team}) if team.startswith('team_') else ''
    data = vercel_api('/v9/projects/' + project + suffix)
    if data.get('id') != project or data.get('accountId') != team:
        raise ValueError('Vercel project owner mismatch')
    previous = data.get('targets', {}).get('production', {})
    identifier = previous.get('id')
    if not re.fullmatch(r'dpl_[A-Za-z0-9]+', identifier or ''):
        raise ValueError('Existing production deployment required for application-only rollback')
    deployed = vercel_api('/v13/deployments/' + identifier + suffix)
    if deployed.get('projectId') != project or deployed.get('target') != 'production' or deployed.get('readyState') != 'READY':
        raise ValueError('Previous production deployment identity/readiness mismatch')
    origin = assert_public_origin(os.environ.get('PRODUCTION_WEB_ORIGIN', ''))
    aliases = deployed.get('alias', [])
    if urlsplit(origin).hostname not in aliases:
        raise ValueError('Production web origin is not an alias of the verified Vercel project')
    return project, team, identifier, origin


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []

    def handle_starttag(self, tag, attributes):
        if tag == 'script':
            attributes = dict(attributes)
            if attributes.get('src'):
                self.scripts.append(attributes['src'])


def smoke(origin, expected_directory=None):
    origin = assert_public_origin(origin)
    with urlopen(origin + '/', timeout=30) as response:
        if response.status != 200 or 'text/html' not in response.headers.get('Content-Type', ''):
            raise ValueError('Production static HTML smoke check failed')
        if urlsplit(response.url).netloc != urlsplit(origin).netloc:
            raise ValueError('Unexpected production redirect')
        html_bytes = response.read(2_000_000)
        html = html_bytes.decode()
    if expected_directory and hashlib.sha256(html_bytes).hexdigest() != digest(Path(expected_directory) / 'index.html'):
        raise ValueError('Served HTML does not match the selected immutable artifact')
    scripts = Scripts()
    scripts.feed(html)
    paths = [urljoin(origin + '/', value) for value in scripts.scripts]
    paths = [value for value in paths if urlsplit(value).netloc == urlsplit(origin).netloc
             and urlsplit(value).path.startswith('/assets/') and urlsplit(value).path.endswith('.js')]
    if not paths:
        raise ValueError('Critical same-origin production JavaScript asset missing')
    for value in paths:
        with urlopen(value, timeout=30) as response:
            content_type = response.headers.get('Content-Type', '')
            if response.status != 200 or ('javascript' not in content_type and 'ecmascript' not in content_type):
                raise ValueError('Critical JavaScript asset smoke check failed')
            if not response.read(1):
                raise ValueError('Empty critical JavaScript asset')
        if expected_directory:
            path = Path(expected_directory) / urlsplit(value).path.lstrip('/')
            if not path.is_file() or Path(expected_directory).resolve() not in path.resolve().parents:
                raise ValueError('Served JavaScript path is outside the selected artifact')
            checksum = hashlib.sha256()
            with urlopen(value, timeout=30) as response:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    checksum.update(chunk)
            if checksum.hexdigest() != digest(path):
                raise ValueError('Served JavaScript differs from the selected artifact')


def cli(arguments, cwd):
    result = subprocess.run(['vercel', *arguments, '--token', os.environ['VERCEL_TOKEN'], '--yes'],
                            cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError('Vercel operation failed; inspect protected provider deployment logs')
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    activation_guard(args.apply)
    policy = json.loads((Path(__file__).parent / 'policy.json').read_text())
    environment_guard(policy['repository'])
    directory = Path(tempfile.mkdtemp(prefix='terracart-web-', dir=os.environ.get('RUNNER_TEMP')))
    commit = download(policy, args.run_id, directory)
    payload = directory / 'payload'
    manifest = verify(payload, policy['repository'], commit, 'web')
    public = manifest['public_config']
    if public.get('VITE_NODE_API_URL') != assert_public_origin(os.environ.get('PRODUCTION_API_ORIGIN', '')):
        raise ValueError('Artifact API origin differs from reviewed production configuration')
    if public.get('VITE_FALLBACK_API_URL') != assert_public_origin(os.environ.get('PRODUCTION_FALLBACK_API_ORIGIN', '')):
        raise ValueError('Artifact fallback origin differs from reviewed production configuration')
    if policy.get('test_script') and (public.get('VITE_CUSTOMER_BASE_URL') != assert_public_origin(os.environ.get('PRODUCTION_CUSTOMER_ORIGIN', ''))
                                    or public.get('VITE_FEATURE_COSTING_ENABLED') != os.environ.get('PUBLIC_FEATURE_COSTING_ENABLED')):
        raise ValueError('Admin artifact customer origin/costing flag differs from production configuration')
    project, team, previous, origin = target()
    smoke(origin)
    if not args.apply:
        print('DRY RUN: artifact, project, current site and rollback target verified; no provider mutations')
        return
    (payload / '.vercel/project.json').write_text(json.dumps({'projectId': project, 'orgId': team}) + '\n')
    try:
        cli(['deploy', '--prebuilt', '--prod'], payload)
        smoke(origin, payload / '.vercel/output/static')
    except Exception:
        cli(['rollback', previous, '--timeout', '120s'], payload)
        smoke(origin)
        raise ValueError('Deployment failed; previous Vercel production artifact restored; database untouched') from None
    print(f'Production static artifact verified: {policy["repository"]} {commit}; no database commands')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'DEPLOYMENT REFUSED: {error}')
