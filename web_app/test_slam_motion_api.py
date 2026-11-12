"""Regression tests for arbitrary focal-plane targets and motion endpoints."""

import base64
import concurrent.futures
import gc
import io
import json
import os
import tempfile
import unittest
import uuid
import zipfile
from unittest.mock import patch

import numpy as np
from PIL import Image

from app import (
    SLAM_MOTION_JOBS,
    SLAM_MOTION_JOBS_LOCK,
    SLMPatternGenerator,
    app,
)
from usb_slm_control import SLMDriverError, SLMSequenceUploadError


class IndependentSpotAlgorithmTests(unittest.TestCase):
    def setUp(self):
        self.width = 64
        self.height = 64
        self.targets = [
            {'x_mm': -0.004, 'y_mm': 0.003, 'weight': 1.0},
            {'x_mm': 0.001, 'y_mm': -0.002, 'weight': 1.0},
            {'x_mm': 0.006, 'y_mm': 0.004, 'weight': 1.0},
        ]

    def generate(self, algorithm):
        return SLMPatternGenerator.fresnel_three_spots(
            width=self.width,
            height=self.height,
            focal_length=1.0,
            wavelength=532,
            algorithm=algorithm,
            incident_beam_diameter_mm=6.0,
            iterations=2,
            target_spots=self.targets,
            spot_radius_mm=0.003,
        )

    def test_analytic_accepts_independent_two_dimensional_targets(self):
        phase = self.generate('analytic')
        self.assertEqual(phase.shape, (self.height, self.width))
        self.assertGreater(np.unique(phase).size, 16)

    def test_uniform_grating_accepts_independent_two_dimensional_targets(self):
        phase = self.generate('uniform_grating')
        self.assertEqual(phase.shape, (self.height, self.width))
        self.assertGreater(np.unique(phase).size, 16)

    def test_dammann_accepts_a_translated_regular_one_by_three_array(self):
        targets = [
            {'x_mm': 0.002, 'y_mm': 0.001, 'weight': 1.0},
            {'x_mm': 0.006, 'y_mm': 0.001, 'weight': 1.0},
            {'x_mm': 0.010, 'y_mm': 0.001, 'weight': 1.0},
        ]
        phase = SLMPatternGenerator.fresnel_three_spots(
            width=self.width,
            height=self.height,
            focal_length=1.0,
            wavelength=532,
            algorithm='dammann',
            incident_beam_diameter_mm=0.6,
            target_spots=targets,
        )
        self.assertEqual(phase.shape, (self.height, self.width))

    def test_dammann_rejects_non_regular_independent_targets(self):
        with self.assertRaisesRegex(ValueError, '等间距|1×3'):
            self.generate('dammann')


class MotionJobApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_output = tempfile.TemporaryDirectory()
        self.output_patch = patch('app.LINGO_OUTPUT_DIR', self.temp_output.name)
        self.output_patch.start()
        app.config['TESTING'] = True
        self.client = app.test_client()

    def tearDown(self):
        self.output_patch.stop()
        self.temp_output.cleanup()

    def valid_payload(self):
        return {
            'calibration': {
                'origin_x_px': 10,
                'origin_y_px': 10,
                'pixels_per_um': 1,
                'y_up': True,
                'focus_scale_x': 1,
                'focus_scale_y': 1,
                'magnification': 50,
            },
            'paths': [
                {'id': 'spot-1', 'waypoints': [{'x_um': -10, 'y_um': 0}, {'x_um': -9, 'y_um': 0}]},
                {'id': 'spot-2', 'waypoints': [{'x_um': 0, 'y_um': 0}]},
                {'id': 'spot-3', 'waypoints': [{'x_um': 10, 'y_um': 0}]},
            ],
            'parameters': {
                'focal_length_um': 1000,
                'wavelength_nm': 532,
                'magnification': 50,
                'algorithm': 'analytic',
                'phase_direction': 'standard',
                'incident_beam_diameter_mm': 6,
                'spot_diameter_um': 6,
                'width': 64,
                'height': 64,
                'speed_um_s': 2,
                'frame_interval_ms': 500,
                'iterations': 2,
                'output_width': 64,
                'output_height': 64,
            },
        }

    def test_create_job_rejects_invalid_frame_count_before_output(self):
        payload = self.valid_payload()
        payload['paths'][0]['waypoints'] = [
            {'x_um': -10, 'y_um': 0}, {'x_um': 1000, 'y_um': 0}
        ]
        payload['parameters']['frame_interval_ms'] = 1
        response = self.client.post('/api/slam/motion/jobs', json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_create_job_rejects_excessive_estimated_pixel_budget(self):
        payload = self.valid_payload()
        payload['paths'][0]['waypoints'] = [
            {'x_um': -100, 'y_um': 0}, {'x_um': -70, 'y_um': 0}
        ]
        payload['paths'][1]['waypoints'] = [{'x_um': 0, 'y_um': 0}]
        payload['paths'][2]['waypoints'] = [{'x_um': 100, 'y_um': 0}]
        payload['parameters'].update({
            'width': 4096,
            'height': 4096,
            'output_width': 2048,
            'output_height': 2048,
            'frame_interval_ms': 150,
        })
        response = self.client.post('/api/slam/motion/jobs', json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn('预计处理像素量', response.get_json()['error'])

    def test_generate_job_writes_phase_and_reconstruction_and_exports_zip(self):
        payload = self.valid_payload()
        with patch('app.SLMPatternGenerator.fresnel_three_spots') as generator, \
                patch('app.FourierSimulator.run_simulation') as simulator:
            generator.return_value = np.arange(64 * 64, dtype=np.uint8).reshape(64, 64)
            small = Image.new('RGB', (8, 8), (10, 20, 30))
            buffer = io.BytesIO()
            small.save(buffer, format='PNG')
            reconstruction = 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')
            simulator.return_value = {'intensity_color': reconstruction}

            response = self.client.post('/api/slam/motion/jobs', json=payload)
            self.assertEqual(response.status_code, 202, response.get_json())
            job_id = response.get_json()['job_id']
            first = self.client.post(f'/api/slam/motion/jobs/{job_id}/next')
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.get_json()['index'], 0)
            self.assertEqual(first.get_json()['completed_frames'], 1)
            self.assertFalse(first.get_json()['complete'])
            second = self.client.post(f'/api/slam/motion/jobs/{job_id}/next')
            self.assertEqual(second.status_code, 200)
            self.assertTrue(second.get_json()['complete'])
            self.assertEqual(second.get_json()['completed_frames'], 2)
            self.assertEqual(second.get_json()['index'], 1)

            status = self.client.get(f'/api/slam/motion/jobs/{job_id}').get_json()
            self.assertEqual(status['status'], 'complete')
            phase = self.client.get(status['frames'][0]['phase_url'])
            self.assertEqual(phase.status_code, 200)
            with Image.open(io.BytesIO(phase.data)) as phase_image:
                self.assertEqual(phase_image.mode, 'L')
            phase.close()
            decoded = self.client.get(status['frames'][0]['reconstruction_url'])
            self.assertEqual(decoded.status_code, 200)
            decoded.close()
            exported = self.client.get(status['export_url'])
            self.assertEqual(exported.status_code, 200)
            self.assertEqual(exported.mimetype, 'application/zip')
            exported.close()

            # Concurrent export requests all observe a complete archive.  The
            # endpoint serializes creation and atomically publishes the ZIP.
            def export_once(_):
                with app.test_client() as client:
                    return client.get(status['export_url'])

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                exports = list(pool.map(export_once, range(4)))
            self.assertTrue(all(item.status_code == 200 for item in exports))
            with zipfile.ZipFile(
                os.path.join(self.temp_output.name, os.listdir(self.temp_output.name)[0],
                             job_id, 'phase_sequence.zip')
            ) as archive:
                self.assertIn('manifest.json', archive.namelist())
            for item in exports:
                item.close()

        self.assertEqual(generator.call_count, 2)
        first_call = generator.call_args_list[0].kwargs
        self.assertEqual(first_call['focal_length'], 1.0)
        self.assertEqual(first_call['incident_beam_diameter_mm'], 6.0)
        self.assertAlmostEqual(first_call['spot_radius_mm'], 0.003)

    def test_job_frame_route_rejects_unknown_job_and_index(self):
        response = self.client.get('/api/slam/motion/jobs/missing/frames/0/phase')
        self.assertEqual(response.status_code, 404)


class FakeMotionUploadController:
    def __init__(self, driver_name='real', connected=True, fail_on_slot=None):
        self.driver_name = driver_name
        self.connected = connected
        self.fail_on_slot = fail_on_slot
        self.write_calls = []
        self.restore_calls = []
        self.sequence_calls = []
        self.fmem = {5: b'old-slot-5', 6: b'old-slot-6'}

    def status(self):
        return {'connected': self.connected}

    def sequence_state(self):
        return {'playing': False}

    def write_fmem_sequence(self, frames, steps, loop=True, bid=None, require_real=False):
        if not self.connected:
            raise SLMDriverError('设备未连接')
        if self.driver_name == 'sim' and require_real:
            raise SLMDriverError('当前连接使用模拟驱动')
        backups = {step['slot']: self.fmem.get(step['slot'], b'empty') for step in steps}
        uploaded = 0
        try:
            for data, step in zip(frames, steps):
                slot = step['slot']
                self.write_calls.append((data, slot))
                self.fmem[slot] = data
                if slot == self.fail_on_slot:
                    raise RuntimeError(f'write failed at slot {slot}')
                uploaded += 1
            self.sequence_calls.append((steps, loop))
            return {'uploaded_count': uploaded,
                    'sequence': {'playing': True, 'frame_count': len(steps)}}
        except Exception as exc:
            restore_failed = []
            for slot, data in backups.items():
                self.restore_calls.append(slot)
                self.fmem[slot] = data
            raise SLMSequenceUploadError(str(exc), uploaded, restore_failed) from exc


class MotionUploadApiTests(unittest.TestCase):
    WIDTH = 1272
    HEIGHT = 1024

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.job_id = uuid.uuid4().hex
        self.frame_values = (31, 207)
        generated_frames = []
        for index, value in enumerate(self.frame_values):
            filename = f'phase_{index + 1:04d}.bmp'
            Image.new('L', (self.WIDTH, self.HEIGHT), color=value).save(
                os.path.join(self.temp_dir.name, filename), format='BMP'
            )
            generated_frames.append({
                'index': index,
                'duration_ms': (index + 1) * 250,
                'phase_file': filename,
            })

        self.job = {
            'id': self.job_id,
            'status': 'complete',
            'directory': self.temp_dir.name,
            'parameters': {'width': self.WIDTH, 'height': self.HEIGHT},
            'generated_frames': generated_frames,
        }
        with SLAM_MOTION_JOBS_LOCK:
            SLAM_MOTION_JOBS[self.job_id] = self.job

        app.config['TESTING'] = True
        self.client = app.test_client()

    def tearDown(self):
        with SLAM_MOTION_JOBS_LOCK:
            SLAM_MOTION_JOBS.pop(self.job_id, None)
        gc.collect()
        self.temp_dir.cleanup()

    def upload(self, **overrides):
        payload = {
            'job_id': self.job_id,
            'start_slot': 5,
            'overwrite_confirmed': True,
            'loop': False,
        }
        payload.update(overrides)
        return self.client.post('/api/usb_slm/motion/upload', json=payload)

    def patch_controller(self, controller):
        return patch(
            'usb_slm_control.USB_SLMController.instance',
            return_value=controller,
        )

    def test_real_driver_uploads_frames_to_slots_and_starts_timed_sequence(self):
        controller = FakeMotionUploadController(driver_name='real')
        with self.patch_controller(controller):
            response = self.upload()

        self.assertEqual(response.status_code, 200, response.get_json())
        body = response.get_json()
        self.assertTrue(body['success'])
        self.assertEqual(body['driver'], 'real')
        self.assertEqual(body['uploaded_count'], 2)
        self.assertTrue(body['sequence_started'])
        self.assertEqual(
            controller.write_calls,
            [(bytes([31]) * (self.WIDTH * self.HEIGHT), 5),
             (bytes([207]) * (self.WIDTH * self.HEIGHT), 6)],
        )
        self.assertEqual(controller.sequence_calls, [(
            [{'slot': 5, 'duration_ms': 250},
             {'slot': 6, 'duration_ms': 500}],
            False,
        )])

    def test_simulated_driver_is_refused_without_writes_or_playback(self):
        controller = FakeMotionUploadController(driver_name='sim')
        with self.patch_controller(controller):
            response = self.upload()

        self.assertEqual(response.status_code, 409)
        self.assertIn('模拟驱动', response.get_json()['error'])
        self.assertEqual(controller.write_calls, [])
        self.assertEqual(controller.sequence_calls, [])

    def test_disconnected_controller_is_refused(self):
        controller = FakeMotionUploadController(connected=False)
        with self.patch_controller(controller):
            response = self.upload()

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['error'], '设备未连接')
        self.assertEqual(controller.write_calls, [])

    def test_missing_overwrite_confirmation_is_refused_before_controller_access(self):
        with self.patch_controller(FakeMotionUploadController()) as controller_instance:
            response = self.upload(overwrite_confirmed=False)

        self.assertEqual(response.status_code, 400)
        self.assertIn('必须确认', response.get_json()['error'])
        controller_instance.assert_not_called()

    def test_slot_overflow_is_rejected_before_controller_access(self):
        with self.patch_controller(FakeMotionUploadController()) as controller_instance:
            response = self.upload(start_slot=818)

        self.assertEqual(response.status_code, 400)
        self.assertIn('超出', response.get_json()['error'])
        controller_instance.assert_not_called()

    def test_parameter_dimension_mismatch_is_rejected_before_controller_access(self):
        self.job['parameters']['width'] = 64
        with self.patch_controller(FakeMotionUploadController()) as controller_instance:
            response = self.upload()

        self.assertEqual(response.status_code, 400)
        self.assertIn('1272×1024', response.get_json()['error'])
        controller_instance.assert_not_called()

    def test_missing_phase_file_is_preflighted_before_any_write(self):
        os.remove(os.path.join(self.temp_dir.name, 'phase_0002.bmp'))
        controller = FakeMotionUploadController()
        with self.patch_controller(controller):
            response = self.upload()

        self.assertEqual(response.status_code, 400)
        self.assertIn('相位文件不存在', response.get_json()['error'])
        self.assertEqual(controller.write_calls, [])
        self.assertEqual(controller.sequence_calls, [])

    def test_write_failure_reports_partial_upload_and_never_starts_playback(self):
        controller = FakeMotionUploadController(fail_on_slot=6)
        with self.patch_controller(controller):
            response = self.upload()

        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertFalse(body['success'])
        self.assertEqual(body['uploaded_count'], 1)
        self.assertFalse(body['sequence_started'])
        self.assertEqual([slot for _, slot in controller.write_calls], [5, 6])
        self.assertEqual(controller.sequence_calls, [])
        self.assertEqual(controller.restore_calls, [5, 6])
        self.assertEqual(controller.fmem[5], b'old-slot-5')
        self.assertEqual(controller.fmem[6], b'old-slot-6')


if __name__ == '__main__':
    unittest.main()
