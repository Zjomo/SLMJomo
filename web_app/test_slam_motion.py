"""Tests for calibrated three-spot motion planning."""

import math
import unittest

from slam_motion import (
    calibrate_pixel_to_sample_um,
    plan_motion_frames,
    sample_to_focus_um,
    validate_minimum_spacing,
)


def make_paths(points_by_spot):
    return [
        {
            'id': f'spot-{index + 1}',
            'waypoints': [
                {'x_um': x, 'y_um': y} for x, y in points
            ],
        }
        for index, points in enumerate(points_by_spot)
    ]


class CalibrationTests(unittest.TestCase):
    def test_pixel_calibration_uses_origin_and_y_axis_direction(self):
        self.assertEqual(
            calibrate_pixel_to_sample_um(
                125, 75, 25, 125, pixels_per_um=10
            ),
            (10.0, 5.0),
        )
        self.assertEqual(
            calibrate_pixel_to_sample_um(
                125, 75, 25, 125, pixels_per_um=10, y_up=False
            ),
            (10.0, -5.0),
        )

    def test_sample_transform_scales_then_rotates(self):
        x_um, y_um = sample_to_focus_um(
            2, 3, scale_x=2, scale_y=1, rotation_deg=90
        )
        self.assertAlmostEqual(x_um, -3)
        self.assertAlmostEqual(y_um, 4)

    def test_calibration_and_transform_reject_invalid_values(self):
        with self.assertRaisesRegex(ValueError, 'pixels_per_um'):
            calibrate_pixel_to_sample_um(1, 1, 0, 0, 0)
        with self.assertRaisesRegex(ValueError, '有限'):
            calibrate_pixel_to_sample_um(math.nan, 1, 0, 0, 1)
        with self.assertRaisesRegex(ValueError, 'scale_x'):
            sample_to_focus_um(1, 2, scale_x=0)
        with self.assertRaisesRegex(ValueError, 'rotation_deg'):
            sample_to_focus_um(1, 2, rotation_deg=math.inf)


class MotionPlanningTests(unittest.TestCase):
    def test_shared_timeline_interpolates_by_distance_and_holds_short_paths(self):
        paths = make_paths([
            [(0, 0), (4, 0)],
            [(10, 0), (12, 0)],
            [(5, 5)],
        ])
        frames = plan_motion_frames(
            paths, speed_um_s=2, frame_interval_ms=500
        )

        self.assertEqual(len(frames), 5)
        self.assertEqual(
            [frame['duration_ms'] for frame in frames],
            [500, 500, 500, 500, 500],
        )
        self.assertEqual(
            [spot['x_um'] for spot in frames[1]['spots']],
            [1.0, 11.0, 5.0],
        )
        self.assertEqual(
            [spot['x_um'] for spot in frames[-1]['spots']],
            [4.0, 12.0, 5.0],
        )
        self.assertEqual(frames[-1]['time_s'], 2.0)

    def test_polyline_interpolation_uses_arc_length_and_exact_final_endpoint(self):
        paths = make_paths([
            [(0, 0), (0, 2), (2, 2)],
            [(5, 0)],
            [(10, 0)],
        ])
        frames = plan_motion_frames(
            paths, speed_um_s=2, frame_interval_ms=750
        )

        self.assertEqual([frame['time_s'] for frame in frames], [0, 0.75, 1.5, 2.0])
        self.assertAlmostEqual(frames[1]['spots'][0]['x_um'], 0)
        self.assertAlmostEqual(frames[1]['spots'][0]['y_um'], 1.5)
        self.assertAlmostEqual(frames[2]['spots'][0]['x_um'], 1)
        self.assertAlmostEqual(frames[2]['spots'][0]['y_um'], 2)
        self.assertEqual(frames[-1]['spots'][0]['x_um'], 2)
        self.assertEqual(frames[-1]['spots'][0]['y_um'], 2)
        self.assertEqual(frames[-1]['duration_ms'], 750)

    def test_one_point_paths_and_zero_motion_produce_one_frame(self):
        frames = plan_motion_frames(
            make_paths([[(1, 2)], [(3, 4)], [(5, 6)]]),
            speed_um_s=2,
            frame_interval_ms=100,
        )
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]['duration_ms'], 100)
        self.assertEqual(
            [(s['x_um'], s['y_um']) for s in frames[0]['spots']],
            [(1, 2), (3, 4), (5, 6)],
        )

    def test_frame_cap_is_checked_before_frame_materialization(self):
        with self.assertRaisesRegex(ValueError, '帧数.*上限'):
            plan_motion_frames(
                make_paths([
                    [(0, 0), (1000, 0)],
                    [(0, 10)],
                    [(0, 20)],
                ]),
                speed_um_s=1,
                frame_interval_ms=1,
                max_frames=10,
            )

    def test_invalid_path_and_timing_inputs_are_rejected(self):
        valid = make_paths([[(0, 0)], [(10, 0)], [(20, 0)]])
        with self.assertRaisesRegex(ValueError, '三个'):
            plan_motion_frames(valid[:2], 1, 100)
        with self.assertRaisesRegex(ValueError, '唯一'):
            duplicate_ids = [dict(path) for path in valid]
            duplicate_ids[1]['id'] = duplicate_ids[0]['id']
            plan_motion_frames(duplicate_ids, 1, 100)
        with self.assertRaisesRegex(ValueError, 'waypoints'):
            missing_points = [dict(path) for path in valid]
            missing_points[0]['waypoints'] = []
            plan_motion_frames(missing_points, 1, 100)
        with self.assertRaisesRegex(ValueError, '有限'):
            invalid_coord = make_paths([
                [(0, 0)], [(10, math.inf)], [(20, 0)]
            ])
            plan_motion_frames(invalid_coord, 1, 100)
        with self.assertRaisesRegex(ValueError, 'speed_um_s'):
            plan_motion_frames(valid, 0, 100)
        with self.assertRaisesRegex(ValueError, 'frame_interval_ms'):
            plan_motion_frames(valid, 1, 0)
        with self.assertRaisesRegex(ValueError, 'max_frames'):
            plan_motion_frames(valid, 1, 100, max_frames=0)

    def test_minimum_spacing_rejects_colliding_spots(self):
        frames = plan_motion_frames(
            make_paths([[(0, 0)], [(0.5, 0)], [(5, 0)]]),
            speed_um_s=1,
            frame_interval_ms=100,
        )
        with self.assertRaisesRegex(ValueError, '最小间距'):
            validate_minimum_spacing(frames, min_spacing_um=1)

        separated = plan_motion_frames(
            make_paths([[(0, 0)], [(1, 0)], [(5, 0)]]),
            speed_um_s=1,
            frame_interval_ms=100,
        )
        self.assertIsNone(validate_minimum_spacing(separated, 1))

    def test_paths_crossing_at_different_times_are_not_a_collision(self):
        frames = plan_motion_frames(
            make_paths([
                [(-10, 0), (0, 0)],
                [(0, 0), (10, 0)],
                [(0, 20)],
            ]),
            speed_um_s=1,
            frame_interval_ms=1000,
        )
        self.assertIsNone(validate_minimum_spacing(frames, min_spacing_um=5))

    def test_spacing_validator_rejects_invalid_threshold_or_frame(self):
        with self.assertRaisesRegex(ValueError, 'min_spacing_um'):
            validate_minimum_spacing([], -1)
        with self.assertRaisesRegex(ValueError, 'spots'):
            validate_minimum_spacing([{'spots': []}], 1)


if __name__ == '__main__':
    unittest.main()
