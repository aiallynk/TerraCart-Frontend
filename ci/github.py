#!/usr/bin/env python3
"""Read-only GitHub provenance and native environment-protection gates."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile
from artifact import digest, extract, verify


def api(path, *, binary=False):
    result = subprocess.run(['gh', 'api', path], capture_output=True, check=False)
    if result.returncode:
        raise ValueError('Required GitHub metadata/protection could not be verified')
    return result.stdout if binary else json.loads(result.stdout)


def assert_dispatch():
    if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Production is manual and main-branch-only')


def activation_guard(apply):
    if apply and os.environ.get('PRODUCTION_DEPLOYMENTS_ENABLED') != 'true':
        raise ValueError('Production activation remains disabled until CI, native protections and first dry run are verified')


REQUIRED_CHECKS = {'Checks (lint)', 'Checks (test)', 'Checks (security)', 'Build'}


def main_guard(repository):
    try:
        rules = api(f'repos/{repository}/rules/branches/main')
    except ValueError:
        rules = []
    if not isinstance(rules, list):
        rules = []
    reviews = any(row.get('type') == 'pull_request' and row.get('parameters', {}).get('required_approving_review_count', 0) >= 1
                  for row in rules if isinstance(row, dict))
    contexts = {item.get('context') for row in rules if isinstance(row, dict) and row.get('type') == 'required_status_checks'
                for item in row.get('parameters', {}).get('required_status_checks', [])}
    if reviews and REQUIRED_CHECKS <= contexts:
        return
    try:
        protection = api(f'repos/{repository}/branches/main/protection')
    except ValueError:
        raise ValueError('Protected main with reviewed PRs and all four required CI checks must be verified') from None
    status = protection.get('required_status_checks') or {}
    contexts = set(status.get('contexts', [])) | {row.get('context') for row in status.get('checks', [])}
    reviews = (protection.get('required_pull_request_reviews') or {}).get('required_approving_review_count', 0) >= 1
    if not reviews or not REQUIRED_CHECKS <= contexts:
        raise ValueError('Main protection must require reviewed PRs and all four CI checks')


def assert_run(run, workflow_id, repository):
    if (run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('event') != 'push' or run.get('head_branch') != 'main'
            or run.get('workflow_id') != workflow_id
            or run.get('head_repository', {}).get('full_name') != repository
            or not re.fullmatch(r'[a-f0-9]{40}', run.get('head_sha', ''))):
        raise ValueError('Only successful same-repository main-push CI runs may deploy')


def environment_guard(repository):
    assert_dispatch()
    main_guard(repository)
    environment = api(f'repos/{repository}/environments/production')
    if not any(rule.get('type') == 'required_reviewers' and rule.get('reviewers')
               for rule in environment.get('protection_rules', [])):
        raise ValueError('Native production environment reviewers must be configured; no custom approval substitute')
    policy = environment.get('deployment_branch_policy') or {}
    if policy.get('protected_branches'):
        raise ValueError('Select main-only environment deployment branches; all-protected-branches is insufficient')
    elif policy.get('custom_branch_policies'):
        rows = api(f'repos/{repository}/environments/production/deployment-branch-policies')['branch_policies']
        if not rows or any(row['name'] != 'main' or row.get('type', 'branch') != 'branch' for row in rows):
            raise ValueError('Production deployment branches must be restricted to main')
    else:
        raise ValueError('Production environment branch restriction is required')


def download(policy, run_id, destination):
    assert_dispatch()
    if not re.fullmatch(r'[1-9]\d*', str(run_id)):
        raise ValueError('Numeric CI run ID is required')
    repository = policy['repository']
    workflow = api(f'repos/{repository}/actions/workflows/{policy["workflow"]}')
    run = api(f'repos/{repository}/actions/runs/{run_id}')
    assert_run(run, workflow['id'], repository)
    name = policy['artifact_name'] + '-' + run['head_sha']
    rows = api(f'repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100')['artifacts']
    matches = [row for row in rows if row['name'] == name and not row['expired']]
    if len(matches) != 1:
        raise ValueError('Expected unique, unexpired CI artifact is missing')
    artifact = matches[0]
    if artifact.get('size_in_bytes', 0) > 2_000_000_000:
        raise ValueError('GitHub artifact size limit exceeded')
    expected = artifact.get('digest', '').removeprefix('sha256:')
    if not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('GitHub artifact digest is unavailable')
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / 'github-artifact.zip'
    archive_path.write_bytes(api(f'repos/{repository}/actions/artifacts/{artifact["id"]}/zip', binary=True))
    if digest(archive_path) != expected:
        raise ValueError('GitHub archive checksum mismatch')
    with zipfile.ZipFile(archive_path) as package:
        if len(package.namelist()) != 2 or set(package.namelist()) != {'artifact.tar.gz', 'artifact.tar.gz.sha256'}:
            raise ValueError('Unexpected CI artifact archive members')
        if sum(item.file_size for item in package.infolist()) > 2_000_000_000:
            raise ValueError('CI artifact archive is too large')
        package.extractall(destination)
    payload = destination / 'payload'
    expected_payload = (destination / 'artifact.tar.gz.sha256').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', expected_payload) or digest(destination / 'artifact.tar.gz') != expected_payload:
        raise ValueError('Payload checksum mismatch')
    extract(destination / 'artifact.tar.gz', payload)
    manifest = verify(payload, repository, run['head_sha'], policy['kind'],
                      expected_environment='validation' if policy['kind'] == 'flutter' else 'production')
    if str(manifest['run_id']) != str(run_id):
        raise ValueError('Artifact run ID mismatch')
    print(f'Validated repository={repository} commit={run["head_sha"]} CI run={run_id}')
    return run['head_sha']


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['environment', 'download'])
    parser.add_argument('--run-id')
    parser.add_argument('--destination')
    args = parser.parse_args()
    policy = json.loads((Path(__file__).parent / 'policy.json').read_text())
    if args.action == 'environment':
        environment_guard(policy['repository'])
    else:
        download(policy, args.run_id, args.destination)
