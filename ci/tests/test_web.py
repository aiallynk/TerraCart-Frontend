import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import artifact
import deploy_web as deploy


class Response(io.BytesIO):
    def __init__(self, body, content_type, url):
        super().__init__(body)
        self.status = 200
        self.headers = {'Content-Type': content_type}
        self.url = url


class WebDeploymentSafety(unittest.TestCase):
    def test_missing_critical_asset_and_html_as_javascript_fail(self):
        with patch.object(deploy, 'urlopen', return_value=Response(b'<html></html>', 'text/html', 'https://web.example.com/')):
            with self.assertRaises(ValueError):
                deploy.smoke('https://web.example.com')
        responses = [Response(b'<script src="/assets/app.js"></script>', 'text/html', 'https://web.example.com/'),
                     Response(b'<html>fallback</html>', 'text/html', 'https://web.example.com/assets/app.js')]
        with patch.object(deploy, 'urlopen', side_effect=responses):
            with self.assertRaises(ValueError):
                deploy.smoke('https://web.example.com')

    def test_no_rollback_target_or_wrong_owner_refuses(self):
        with patch.dict(os.environ, {'VERCEL_PROJECT_ID': 'prj_fixture', 'VERCEL_ORG_ID': 'team_fixture'}):
            for data in [{'id': 'prj_fixture', 'accountId': 'wrong'},
                         {'id': 'prj_fixture', 'accountId': 'team_fixture', 'targets': {}}]:
                with patch.object(deploy, 'vercel_api', return_value=data):
                    with self.assertRaises(ValueError):
                        deploy.target()

    def invoke(self, *, apply=False, failure=False):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            policy = json.loads((Path(deploy.__file__).parent / 'policy.json').read_text())
            public = {'VITE_NODE_API_URL': 'https://api.example.com', 'VITE_FALLBACK_API_URL': 'https://api.example.com'}
            if policy.get('test_script'):
                public.update(VITE_CUSTOMER_BASE_URL='https://web.example.com', VITE_FEATURE_COSTING_ENABLED='false')
            def download(policy, run_id, destination):
                payload = Path(destination) / 'payload'
                (payload / '.vercel/output').mkdir(parents=True)
                (payload / '.vercel/output/config.json').write_text('{"version":3}')
                artifact.write_manifest(payload, kind='web', repository=policy['repository'], commit='a' * 40,
                                        environment='production', public_config=public)
                return 'a' * 40
            args = ['deploy_web.py', '--run-id', '123'] + (['--apply'] if apply else [])
            env = {'RUNNER_TEMP': str(directory), 'PRODUCTION_API_ORIGIN': 'https://api.example.com',
                   'PRODUCTION_DEPLOYMENTS_ENABLED': 'true',
                   'PRODUCTION_FALLBACK_API_ORIGIN': 'https://api.example.com',
                   'PRODUCTION_CUSTOMER_ORIGIN': 'https://web.example.com', 'PUBLIC_FEATURE_COSTING_ENABLED': 'false'}
            with patch.dict(os.environ, env), patch.object(sys, 'argv', args), \
                 patch.object(deploy, 'environment_guard'), patch.object(deploy, 'download', side_effect=download), \
                 patch.object(deploy, 'target', return_value=('prj_fixture', 'team_fixture', 'dpl_previous', 'https://web.example.com')), \
                 patch.object(deploy, 'cli') as cli, patch.object(deploy, 'smoke') as smoke:
                if failure:
                    smoke.side_effect = [None, ValueError('fixture smoke failure'), None]
                    with self.assertRaisesRegex(ValueError, 'previous Vercel'):
                        deploy.main()
                else:
                    deploy.main()
                return [call.args[0] for call in cli.call_args_list]

    def test_dry_run_never_deploys(self):
        self.assertEqual(self.invoke(), [])

    def test_failed_smoke_rolls_back_previous_production_artifact(self):
        self.assertEqual(self.invoke(apply=True, failure=True),
                         [['deploy', '--prebuilt', '--prod'], ['rollback', 'dpl_previous', '--timeout', '120s']])


if __name__ == '__main__':
    unittest.main()
