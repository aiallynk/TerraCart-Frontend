import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import artifact
import github
import checks

SHA = 'a' * 40
REPOSITORY = 'owner/application'


class ArtifactSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.payload = self.directory / 'payload'
        self.payload.mkdir()
        (self.payload / 'application.js').write_text('safe fixture')
        artifact.write_manifest(self.payload, kind='backend', repository=REPOSITORY,
                                commit=SHA, environment='production')

    def tearDown(self):
        self.temporary.cleanup()  # Only this test's isolated local directory.

    def test_manifest_detects_corruption_and_wrong_provenance(self):
        artifact.verify(self.payload, REPOSITORY, SHA, 'backend')
        for repository, commit, kind in [('foreign/repo', SHA, 'backend'),
                                         (REPOSITORY, 'b' * 40, 'backend'),
                                         (REPOSITORY, SHA, 'web')]:
            with self.assertRaises(ValueError):
                artifact.verify(self.payload, repository, commit, kind)
        (self.payload / 'application.js').write_text('altered')
        with self.assertRaises(ValueError):
            artifact.verify(self.payload, REPOSITORY, SHA)

    def test_extra_files_and_symlinks_rejected(self):
        (self.payload / 'unexpected').write_text('extra')
        with self.assertRaises(ValueError):
            artifact.verify(self.payload, REPOSITORY, SHA)
        (self.payload / 'unexpected').unlink()
        (self.payload / 'external').symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            artifact.verify(self.payload, REPOSITORY, SHA)

    def test_traversal_link_and_duplicate_archives_rejected(self):
        for names, link in [(['../outside'], False), (['/absolute'], False),
                            (['link'], True), (['same', 'same'], False)]:
            package = self.directory / 'unsafe.tar.gz'
            with tarfile.open(package, 'w:gz') as archive:
                for name in names:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/etc/passwd'
                        archive.addfile(member)
                    else:
                        member.size = 1
                        archive.addfile(member, io.BytesIO(b'x'))
            destination = self.directory / ('result-' + str(len(list(self.directory.iterdir()))))
            with self.assertRaises(ValueError):
                artifact.extract(package, destination)
            self.assertFalse((self.directory / 'outside').exists())

    def test_existing_destination_never_overwritten(self):
        archive = self.directory / 'bundle.tar.gz'
        artifact.archive(self.payload, archive)
        with self.assertRaises(ValueError):
            artifact.extract(archive, self.payload)
        self.assertEqual((self.payload / 'application.js').read_text(), 'safe fixture')

    def test_sensitive_files_cannot_enter_artifact(self):
        (self.payload / '.env').write_text('fixture')
        with self.assertRaises(ValueError):
            artifact.write_manifest(self.payload, kind='backend', repository=REPOSITORY,
                                    commit=SHA, environment='production')

    def test_runtime_data_dependency_cannot_be_silently_omitted(self):
        (self.payload / 'server.js').write_text("require('./data/dictionary.json');")
        with self.assertRaises(ValueError):
            artifact.verify_runtime_imports(self.payload)
        (self.payload / 'data').mkdir()
        (self.payload / 'data/dictionary.json').write_text('{}')
        artifact.verify_runtime_imports(self.payload)

    def test_debug_validation_artifact_is_not_a_production_release(self):
        (self.payload / 'artifact-manifest.json').unlink()
        artifact.write_manifest(self.payload, kind='flutter', repository=REPOSITORY,
                                commit=SHA, environment='validation')
        artifact.verify(self.payload, REPOSITORY, SHA, 'flutter', expected_environment='validation')
        with self.assertRaises(ValueError):
            artifact.verify(self.payload, REPOSITORY, SHA, 'mobile-release')

    def test_origin_rejects_credentials_local_and_private_addresses(self):
        for value in ['http://api.example.com', 'https://user:pass@api.example.com',
                      'https://localhost', 'https://127.0.0.1', 'https://10.0.0.2',
                      'https://api.example.com/path', 'https://api.example.com?token=x']:
            with self.assertRaises(ValueError, msg=value):
                artifact.assert_public_origin(value)
        self.assertEqual(artifact.assert_public_origin('https://api.example.com/'), 'https://api.example.com')


class GitHubSafety(unittest.TestCase):
    def test_activation_is_separately_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            github.activation_guard(False)
            with self.assertRaises(ValueError):
                github.activation_guard(True)
        with patch.dict(os.environ, {'PRODUCTION_DEPLOYMENTS_ENABLED': 'true'}):
            github.activation_guard(True)

    def run_data(self):
        return dict(status='completed', conclusion='success', event='push', head_branch='main',
                    workflow_id=10, head_repository={'full_name': REPOSITORY}, head_sha=SHA)

    def test_failed_pr_feature_fork_and_foreign_workflow_cannot_deploy(self):
        github.assert_run(self.run_data(), 10, REPOSITORY)
        for key, value in [('conclusion', 'failure'), ('status', 'in_progress'),
                           ('event', 'pull_request'), ('head_branch', 'feature'),
                           ('workflow_id', 99), ('head_repository', {'full_name': 'fork/app'}),
                           ('head_sha', 'short')]:
            row = self.run_data()
            row[key] = value
            with self.assertRaises(ValueError):
                github.assert_run(row, 10, REPOSITORY)

    def test_dispatch_must_be_manual_main(self):
        for event, ref in [('push', 'refs/heads/main'), ('workflow_dispatch', 'refs/heads/feature')]:
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': event, 'GITHUB_REF': ref}):
                with self.assertRaises(ValueError):
                    github.assert_dispatch()

    def test_no_native_reviewer_or_main_branch_policy_fails_closed(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main'}), patch.object(github, 'main_guard'):
            for environment in [dict(protection_rules=[]),
                                dict(protection_rules=[{'type': 'required_reviewers', 'reviewers': [{}]}])]:
                with patch.object(github, 'api', return_value=environment):
                    with self.assertRaises(ValueError):
                        github.environment_guard(REPOSITORY)

    def test_main_requires_review_and_all_checks_from_rules_or_classic_protection(self):
        rows = [{'type': 'pull_request', 'parameters': {'required_approving_review_count': 1}},
                {'type': 'required_status_checks', 'parameters': {'required_status_checks': [
                    {'context': context} for context in github.REQUIRED_CHECKS]}}]
        with patch.object(github, 'api', return_value=rows):
            github.main_guard(REPOSITORY)
        classic = {'required_pull_request_reviews': {'required_approving_review_count': 1},
                   'required_status_checks': {'contexts': list(github.REQUIRED_CHECKS)}}
        with patch.object(github, 'api', side_effect=[[], classic]):
            github.main_guard(REPOSITORY)
        for protection in [{}, {'required_status_checks': {'contexts': ['Build']},
                                'required_pull_request_reviews': {'required_approving_review_count': 1}}]:
            with patch.object(github, 'api', side_effect=[[], protection]):
                with self.assertRaises(ValueError):
                    github.main_guard(REPOSITORY)

    def test_production_secrets_stripped_from_checks(self):
        with patch.dict(os.environ, {'AWS_SECRET_ACCESS_KEY': 'fixture', 'BACKEND_SSH_KEY': 'fixture',
                                     'MONGO_URI': 'mongodb://production.example/live',
                                     'GOOGLE_APPLICATION_CREDENTIALS': '/fixture/credential.json'}):
            env = checks.safe_environment()
            self.assertNotIn('AWS_SECRET_ACCESS_KEY', env)
            self.assertNotIn('BACKEND_SSH_KEY', env)
            self.assertNotIn('GOOGLE_APPLICATION_CREDENTIALS', env)
            self.assertEqual(env['MONGO_URI'], 'mongodb://127.0.0.1:27017/terracart_inventory_isolation_test')

    def test_download_verifies_both_archive_checksums_and_run_id(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            payload = root / 'payload'
            payload.mkdir()
            (payload / 'app.js').write_text('fixture')
            with patch.dict(os.environ, {'GITHUB_RUN_ID': '123'}):
                artifact.write_manifest(payload, kind='backend', repository=REPOSITORY,
                                        commit=SHA, environment='production')
            archive = root / 'artifact.tar.gz'
            artifact.archive(payload, archive)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as package:
                package.writestr('artifact.tar.gz', archive.read_bytes())
                package.writestr('artifact.tar.gz.sha256', artifact.digest(archive) + '\n')
            zipped = root / 'github.zip'
            zipped.write_bytes(buffer.getvalue())
            policy = dict(repository=REPOSITORY, workflow='ci.yml', artifact_name='artifact', kind='backend')
            def api(path, binary=False):
                if binary:
                    return buffer.getvalue()
                if path.endswith('/ci.yml'):
                    return {'id': 10}
                if path.endswith('/123'):
                    return self.run_data()
                return {'artifacts': [{'id': 99, 'name': 'artifact-' + SHA, 'expired': False,
                                       'digest': 'sha256:' + artifact.digest(zipped)}]}
            with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main'}), patch.object(github, 'api', side_effect=api):
                self.assertEqual(github.download(policy, '123', root / 'download'), SHA)


if __name__ == '__main__':
    unittest.main()
