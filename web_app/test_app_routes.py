"""Regression tests for file download and preset routes."""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from flask import Flask
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

import app as web_app
from migrate_history_schema import create_database_backup


class AppRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.database_path = Path(cls.temp_dir.name) / 'route-tests.sqlite'
        cls.test_app = Flask('route-test-app', static_folder=None)
        cls.test_app.config.update(web_app.app.config)
        cls.test_app.config.update(
            TESTING=True,
            SQLALCHEMY_DATABASE_URI=str(
                URL.create('sqlite', database=str(cls.database_path))
            )
        )
        web_app.db.init_app(cls.test_app)

        test_routes = {
            '/api/download/<path:filename>',
            '/api/generate',
            '/api/generate/<pattern_type>',
            '/api/history',
            '/api/presets',
            '/api/presets/<int:preset_id>'
        }
        registered_routes = set()
        for rule in web_app.app.url_map.iter_rules():
            if rule.rule in test_routes:
                cls.test_app.add_url_rule(
                    rule.rule,
                    endpoint=rule.endpoint,
                    view_func=web_app.app.view_functions[rule.endpoint],
                    methods=rule.methods,
                    provide_automatic_options=rule.provide_automatic_options
                )
                registered_routes.add(rule.rule)
        missing_routes = test_routes - registered_routes
        if missing_routes:
            raise AssertionError(f'Missing routes for tests: {sorted(missing_routes)}')

        cls.user_database_path = Path(web_app.app.instance_path) / 'fresnel_config.db'
        cls.user_database_hash = hashlib.sha256(cls.user_database_path.read_bytes()).hexdigest()
        with cls.test_app.app_context():
            actual_path = Path(web_app.db.engine.url.database).resolve()
            if actual_path != cls.database_path.resolve():
                raise AssertionError(f'Test database is not isolated: {actual_path}')
            web_app.db.create_all()

    def setUp(self):
        with self.test_app.app_context():
            web_app.db.drop_all()
            web_app.db.create_all()
        self.client = self.test_app.test_client()

    def tearDown(self):
        with self.test_app.app_context():
            web_app.db.session.remove()

    @classmethod
    def tearDownClass(cls):
        try:
            with cls.test_app.app_context():
                web_app.db.session.remove()
                web_app.db.drop_all()
                web_app.db.engine.dispose()
            current_hash = hashlib.sha256(cls.user_database_path.read_bytes()).hexdigest()
            if current_hash != cls.user_database_hash:
                raise AssertionError('Route tests modified the user database')
        finally:
            cls.temp_dir.cleanup()

    def test_download_serves_files_from_output_directory(self):
        with tempfile.TemporaryDirectory() as output_dir:
            filename = 'phase.bmp'
            with open(os.path.join(output_dir, filename), 'wb') as output_file:
                output_file.write(b'phase-data')
            with mock.patch.object(web_app, 'OUTPUT_DIR', output_dir):
                response = self.client.get(f'/api/download/{filename}')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b'phase-data')
                response.close()

    def test_download_rejects_paths_outside_output_directory(self):
        with tempfile.TemporaryDirectory() as root:
            output_dir = os.path.join(root, 'output')
            os.mkdir(output_dir)
            with open(os.path.join(root, 'secret.txt'), 'wb') as secret_file:
                secret_file.write(b'secret')
            with mock.patch.object(web_app, 'OUTPUT_DIR', output_dir):
                response = self.client.get(
                    '/api/download/nested%2F..%2F..%2Fsecret.txt'
                )

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(b'secret', response.data)

    def test_presets_can_be_created_listed_and_deleted(self):
        payload = {
            'name': '532 nm bench setup',
            'description': 'Regression test preset',
            'focus_mm': 1250,
            'wavelength_nm': 532,
            'x_pixels': 1272,
            'y_pixels': 1024,
            'pitch_mode': 1,
            'rotation_degree': 15,
            'offset_x': -3,
            'offset_y': 7,
            'scale_factor': 1.2
        }
        created = self.client.post('/api/presets', json=payload)
        self.assertEqual(created.status_code, 200, created.get_json())
        preset_id = created.get_json()['preset']['id']

        listed = self.client.get('/api/presets').get_json()['presets']
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]['name'], payload['name'])
        self.assertEqual(listed[0]['offset_x'], payload['offset_x'])

        deleted = self.client.delete(f'/api/presets/{preset_id}')
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        self.assertEqual(self.client.get('/api/presets').get_json()['presets'], [])

    def test_history_returns_saved_output_metadata(self):
        parameters = web_app.normalize_history_parameters('fresnel', {
            'focus_mm': 1250,
            'wavelength_nm': 532,
            'input_image': 'data:image/png;base64,' + ('A' * 200000),
            'target_image': 'data:image/png;base64,' + ('B' * 200000)
        })
        with self.test_app.app_context():
            web_app.db.session.add(web_app.GenerationHistory(
                config_name='route-test-pattern',
                focus_mm=1000,
                wavelength_nm=532,
                output_file='phase.bmp',
                parameters_json=json.dumps(parameters)
            ))
            web_app.db.session.commit()

        response = self.client.get('/api/history')
        self.assertEqual(response.status_code, 200)
        history = response.get_json()['history']
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['output_file'], 'phase.bmp')
        self.assertEqual(history[0]['focus_mm'], 1000)
        self.assertEqual(history[0]['parameters']['parameters']['focus_mm'], 1250)
        self.assertNotIn('input_image', history[0]['parameters']['parameters'])

    def test_history_snapshot_allowlist_excludes_images_and_bounds_custom_spots(self):
        snapshot = web_app.normalize_history_parameters('fresnel_three_spots', {
            'focal_length': 1000,
            'wavelength': 532,
            'target_spots': [
                {'x_mm': -0.5, 'y_mm': 0, 'weight': 1},
                {'x_mm': 0.5, 'y_mm': 0, 'weight': 0.8}
            ],
            'target_image': 'data:image/png;base64,' + ('A' * 10000),
            'input_image': 'data:image/png;base64,' + ('B' * 10000),
            'unrecognized': 'discarded'
        })
        self.assertEqual(snapshot['parameters']['focal_length'], 1000)
        self.assertEqual(len(snapshot['parameters']['target_spots']), 2)
        self.assertNotIn('target_image', snapshot['parameters'])
        self.assertNotIn('input_image', snapshot['parameters'])
        self.assertNotIn('unrecognized', snapshot['parameters'])
        self.assertLessEqual(len(json.dumps(snapshot)), 8192)

        invalid_spots = web_app.normalize_history_parameters('fresnel_three_spots', {
            'target_spots': [{'x_mm': float('nan'), 'y_mm': 0, 'weight': 1}]
        })
        self.assertNotIn('target_spots', invalid_spots['parameters'])

    def test_generation_route_persists_normalized_history_parameters(self):
        with tempfile.TemporaryDirectory() as output_dir:
            with mock.patch.object(web_app, 'OUTPUT_DIR', output_dir), \
                    mock.patch.object(
                        web_app.SLMPatternGenerator,
                        'generate_phase',
                        return_value=np.zeros((64, 64), dtype=np.uint8)
                    ), mock.patch.object(web_app.SLMPatternGenerator, 'save_image'):
                response = self.client.post('/api/generate', json={
                    'focus_mm': 1500,
                    'wavelength_nm': 633,
                    'x_pixels': 64,
                    'y_pixels': 64,
                    'pitch_mode': 2,
                    'rotation_degree': 15
                })
        self.assertEqual(response.status_code, 200, response.get_json())
        history = self.client.get('/api/history').get_json()['history'][0]
        self.assertEqual(history['parameters']['pattern_type'], 'fresnel')
        self.assertEqual(history['parameters']['parameters']['focus_mm'], 1500)
        self.assertEqual(history['parameters']['parameters']['wavelength_nm'], 633)
        self.assertNotIn('input_image', history['parameters']['parameters'])

    def test_history_schema_migration_preserves_legacy_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / 'legacy.sqlite'
            engine = create_engine(URL.create('sqlite', database=str(database_path)))
            try:
                with engine.begin() as connection:
                    connection.exec_driver_sql(
                        'CREATE TABLE generation_history ('
                        'id INTEGER PRIMARY KEY, config_name VARCHAR(100), '
                        'focus_mm FLOAT, wavelength_nm FLOAT, input_image VARCHAR(200), '
                        'output_file VARCHAR(200), created_at DATETIME)'
                    )
                    connection.exec_driver_sql(
                        "INSERT INTO generation_history (id, config_name, output_file) "
                        "VALUES (1, 'legacy', 'old.bmp')"
                    )

                backup_path = create_database_backup(database_path)
                self.assertTrue(backup_path.is_file())
                backup_engine = create_engine(
                    URL.create('sqlite', database=str(backup_path))
                )
                try:
                    with backup_engine.connect() as connection:
                        backup_columns = {row[1] for row in connection.exec_driver_sql(
                            'PRAGMA table_info(generation_history)'
                        )}
                        backup_row = connection.exec_driver_sql(
                            'SELECT config_name, output_file '
                            'FROM generation_history WHERE id = 1'
                        ).one()
                    self.assertNotIn('parameters_json', backup_columns)
                    self.assertEqual(backup_row, ('legacy', 'old.bmp'))
                finally:
                    backup_engine.dispose()

                web_app.migrate_generation_history_schema(engine)
                web_app.migrate_generation_history_schema(engine)
                with engine.connect() as connection:
                    columns = {row[1] for row in connection.exec_driver_sql(
                        'PRAGMA table_info(generation_history)'
                    )}
                    row = connection.exec_driver_sql(
                        'SELECT id, config_name, output_file, parameters_json '
                        'FROM generation_history WHERE id = 1'
                    ).one()
                self.assertIn('parameters_json', columns)
                self.assertEqual(row, (1, 'legacy', 'old.bmp', None))
            finally:
                engine.dispose()

    def test_generate_routes_reject_out_of_range_dimensions(self):
        fresnel = self.client.post(
            '/api/generate', json={'x_pixels': 1, 'y_pixels': 512}
        )
        self.assertEqual(fresnel.status_code, 400)
        self.assertIn('64 到 4096', fresnel.get_json()['error'])

        pattern = self.client.post(
            '/api/generate/random', json={'width': 4097, 'height': 512}
        )
        self.assertEqual(pattern.status_code, 400)
        self.assertIn('64 到 4096', pattern.get_json()['error'])


if __name__ == '__main__':
    unittest.main()
