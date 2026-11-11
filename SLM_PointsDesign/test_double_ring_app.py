"""Regression tests for desktop preview scheduling."""

import unittest
from unittest import mock

import numpy as np

from SLM_PointsDesign import double_ring_app


class FakeRoot:
    def __init__(self):
        self.callbacks = []
        self.next_id = 0

    def after(self, _delay, callback, *args):
        self.next_id += 1
        self.callbacks.append((self.next_id, callback, args))
        return self.next_id

    def after_cancel(self, callback_id):
        self.callbacks = [
            item for item in self.callbacks if item[0] != callback_id
        ]

    def run_next(self):
        _, callback, args = self.callbacks.pop(0)
        callback(*args)


class FakeThread:
    instances = []

    def __init__(self, target, args, daemon):
        self.target = target
        self.args = args
        self.daemon = daemon
        self.running = False
        self.instances.append(self)

    def start(self):
        self.running = True

    def is_alive(self):
        return self.running

    def run(self):
        try:
            self.target(*self.args)
        finally:
            self.running = False


class StatusVar:
    def set(self, _value):
        pass


def params_for(version):
    return {
        "width": 32,
        "height": 32,
        "iterations": 1,
        "seed": 1,
        "inner_radius": 2.0,
        "outer_radius": 10.0,
        "inner_width": 1.0,
        "outer_width": 1.0,
        "inner_intensity": 0.7,
        "outer_intensity": 1.0,
        "between_intensity": 0.2,
        "version": version,
    }


class DoubleRingSchedulingTests(unittest.TestCase):
    def setUp(self):
        FakeThread.instances = []
        self.thread_patch = mock.patch.object(
            double_ring_app.threading, "Thread", FakeThread
        )
        self.thread_patch.start()
        self.algorithm_patch = mock.patch.object(
            double_ring_app,
            "double_ring_phase",
            side_effect=lambda **params: tuple(
                np.full((2, 2), params["version"], dtype=np.uint8)
                for _ in range(3)
            ),
        )
        self.algorithm_patch.start()
        self.fft_patch = mock.patch.object(
            double_ring_app, "fft_final_intensity", side_effect=lambda image: image
        )
        self.fft_patch.start()
        self.colormap_patch = mock.patch.object(
            double_ring_app, "apply_colormap", side_effect=lambda image: image
        )
        self.colormap_patch.start()
        self.save_patch = mock.patch.object(double_ring_app, "save_bmp")
        self.save_patch.start()
        self.app = double_ring_app.DoubleRingApp.__new__(
            double_ring_app.DoubleRingApp
        )
        self.app.root = FakeRoot()
        self.app.pending_debounce = None
        self.app.worker = None
        self.app._preview_generation = 0
        self.app._pending_preview = None
        self.app._pending_saves = []
        self.app._active_request_id = None
        self.app._next_request_id = 0
        self.app.last_arrays = {}
        self.app.status_var = StatusVar()
        self.version = 0
        self.app.collect_params = lambda: params_for(self.version)
        self.app._show_curve = lambda _image: None
        self.app._show_image = lambda _key, _image: None

    def tearDown(self):
        mock.patch.stopall()

    def test_latest_preview_runs_after_active_preview_finishes(self):
        self.app._start_preview()
        self.assertEqual(len(FakeThread.instances), 1)

        self.version = 1
        self.app.schedule_preview()
        self.app.root.run_next()
        self.assertEqual(len(FakeThread.instances), 1)

        FakeThread.instances[0].run()
        self.app.root.run_next()

        self.assertEqual(len(FakeThread.instances), 2)
        self.assertEqual(FakeThread.instances[1].args[0]["version"], 1)
        self.assertEqual(self.app.last_arrays, {})

        FakeThread.instances[1].run()
        self.app.root.run_next()
        self.assertEqual(int(self.app.last_arrays["target"][0, 0]), 1)

    def test_save_waits_for_active_work_and_latest_preview(self):
        self.app._start_preview()
        self.version = 1
        with mock.patch.object(double_ring_app.os, "makedirs"):
            self.app.generate_and_save()
        self.app.schedule_preview()
        self.app.root.run_next()

        self.assertEqual(len(FakeThread.instances), 1)

        FakeThread.instances[0].run()
        self.app.root.run_next()
        self.assertEqual(len(FakeThread.instances), 2)
        self.assertIsNotNone(FakeThread.instances[1].args[1])

        FakeThread.instances[1].run()
        self.app.root.run_next()
        self.assertEqual(len(FakeThread.instances), 3)
        self.assertIsNone(FakeThread.instances[2].args[1])
        self.assertEqual(FakeThread.instances[2].args[0]["version"], 1)


if __name__ == "__main__":
    unittest.main()
