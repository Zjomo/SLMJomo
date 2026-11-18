"""Pure calibration and motion-planning helpers for three focal spots."""

import math
from bisect import bisect_right


def _finite_number(value, name):
    if isinstance(value, bool):
        raise ValueError(f'{name} 必须是有限数值')
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{name} 必须是有限数值') from None
    if not math.isfinite(number):
        raise ValueError(f'{name} 必须是有限数值')
    return number


def _positive_number(value, name):
    number = _finite_number(value, name)
    if number <= 0:
        raise ValueError(f'{name} 必须大于 0')
    return number


def _positive_integer(value, name):
    number = _finite_number(value, name)
    if number < 1 or not number.is_integer():
        raise ValueError(f'{name} 必须是大于等于 1 的整数')
    return int(number)


def calibrate_pixel_to_sample_um(
    x_px,
    y_px,
    origin_x_px,
    origin_y_px,
    pixels_per_um,
    y_up=True,
):
    """Convert image pixels to sample-plane micrometres around a marked origin."""
    x = _finite_number(x_px, 'x_px')
    y = _finite_number(y_px, 'y_px')
    origin_x = _finite_number(origin_x_px, 'origin_x_px')
    origin_y = _finite_number(origin_y_px, 'origin_y_px')
    scale = _positive_number(pixels_per_um, 'pixels_per_um')
    if not isinstance(y_up, bool):
        raise ValueError('y_up 必须是布尔值')

    x_um = (x - origin_x) / scale
    y_um = (y - origin_y) / scale
    if y_up:
        y_um = -y_um
    return x_um, y_um


def sample_to_focus_um(
    x_um,
    y_um,
    scale_x=1.0,
    scale_y=1.0,
    rotation_deg=0.0,
):
    """Apply axis scales and a counter-clockwise rotation to sample coordinates."""
    x = _finite_number(x_um, 'x_um')
    y = _finite_number(y_um, 'y_um')
    sx = _positive_number(scale_x, 'scale_x')
    sy = _positive_number(scale_y, 'scale_y')
    rotation = _finite_number(rotation_deg, 'rotation_deg')

    scaled_x = x * sx
    scaled_y = y * sy
    theta = math.radians(rotation)
    cosine = math.cos(theta)
    sine = math.sin(theta)
    focus_x = scaled_x * cosine - scaled_y * sine
    focus_y = scaled_x * sine + scaled_y * cosine
    if not math.isfinite(focus_x) or not math.isfinite(focus_y):
        raise ValueError('变换后的焦平面坐标必须是有限数值')
    return focus_x, focus_y


def _normalize_paths(paths):
    if not isinstance(paths, (list, tuple)) or len(paths) != 3:
        raise ValueError('paths 必须包含恰好三个光斑路径')

    normalized = []
    seen_ids = set()
    for path_index, path in enumerate(paths):
        if not isinstance(path, dict):
            raise ValueError(f'第 {path_index + 1} 条路径格式无效')
        if 'id' not in path:
            raise ValueError(f'第 {path_index + 1} 条路径缺少 id')
        spot_id = path['id']
        try:
            if spot_id in seen_ids:
                raise ValueError('三个光斑 id 必须唯一')
            seen_ids.add(spot_id)
        except TypeError:
            raise ValueError(f'第 {path_index + 1} 条路径 id 必须可哈希') from None

        waypoints = path.get('waypoints')
        if not isinstance(waypoints, (list, tuple)) or not waypoints:
            raise ValueError(f'第 {path_index + 1} 条路径 waypoints 必须至少包含一个点')

        points = []
        for point_index, waypoint in enumerate(waypoints):
            if not isinstance(waypoint, dict) or 'x_um' not in waypoint or 'y_um' not in waypoint:
                raise ValueError(
                    f'第 {path_index + 1} 条路径第 {point_index + 1} 个 waypoint 格式无效'
                )
            points.append((
                _finite_number(waypoint['x_um'], 'x_um'),
                _finite_number(waypoint['y_um'], 'y_um'),
            ))

        cumulative = [0.0]
        for previous, current in zip(points, points[1:]):
            dx = current[0] - previous[0]
            dy = current[1] - previous[1]
            distance = math.hypot(dx, dy)
            total = cumulative[-1] + distance
            if not math.isfinite(distance) or not math.isfinite(total):
                raise ValueError(f'第 {path_index + 1} 条路径总长度必须是有限数值')
            cumulative.append(total)

        normalized.append({
            'id': spot_id,
            'points': points,
            'cumulative': cumulative,
            'length_um': cumulative[-1],
        })
    return normalized


def _point_at_distance(path, distance_um):
    points = path['points']
    cumulative = path['cumulative']
    if distance_um <= 0:
        return points[0]
    if distance_um >= path['length_um']:
        return points[-1]

    segment_end = bisect_right(cumulative, distance_um)
    segment_start = segment_end - 1
    start_distance = cumulative[segment_start]
    end_distance = cumulative[segment_end]
    ratio = (distance_um - start_distance) / (end_distance - start_distance)
    start = points[segment_start]
    end = points[segment_end]
    return (
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
    )


def plan_motion_frames(paths, speed_um_s, frame_interval_ms, max_frames=200):
    """Sample three arc-length paths on a shared time axis.

    Each returned frame contains ``time_s``, a positive ``duration_ms``, and
    three ``spots`` with their original ids and interpolated ``x_um``/``y_um``.
    The last frame is held for one frame interval for deterministic playback.
    """
    normalized = _normalize_paths(paths)
    speed = _positive_number(speed_um_s, 'speed_um_s')
    interval_ms = _positive_integer(frame_interval_ms, 'frame_interval_ms')
    frame_cap = _positive_integer(max_frames, 'max_frames')

    total_duration = max(path['length_um'] / speed for path in normalized)
    if not math.isfinite(total_duration):
        raise ValueError('路径总时长必须是有限数值')

    interval_s = interval_ms / 1000.0
    step_ratio = total_duration / interval_s
    if not math.isfinite(step_ratio):
        raise ValueError(f'规划帧数超过上限 {frame_cap}')

    whole_steps = math.floor(step_ratio)
    regular_endpoint = whole_steps * interval_s
    endpoint_is_regular = math.isclose(
        regular_endpoint, total_duration, rel_tol=1e-12, abs_tol=1e-12
    )
    frame_count = whole_steps + 1 if endpoint_is_regular else whole_steps + 2
    if frame_count > frame_cap:
        raise ValueError(f'规划帧数 {frame_count} 超过上限 {frame_cap}')

    times = [index * interval_s for index in range(whole_steps + 1)]
    if endpoint_is_regular:
        times[-1] = total_duration
    elif total_duration > 0:
        times.append(total_duration)

    frames = []
    for frame_index, time_s in enumerate(times):
        spots = []
        for path in normalized:
            distance_um = min(path['length_um'], speed * time_s)
            x_um, y_um = _point_at_distance(path, distance_um)
            spots.append({
                'id': path['id'],
                'x_um': x_um,
                'y_um': y_um,
            })

        if frame_index + 1 < len(times):
            duration_ms = max(1, round((times[frame_index + 1] - time_s) * 1000))
        else:
            duration_ms = interval_ms
        frames.append({
            'index': frame_index,
            'time_s': time_s,
            'duration_ms': duration_ms,
            'spots': spots,
        })
    return frames


def validate_minimum_spacing(frames, min_spacing_um):
    """Raise when any pair of spots is closer than the requested spacing."""
    minimum = _finite_number(min_spacing_um, 'min_spacing_um')
    if minimum < 0:
        raise ValueError('min_spacing_um 必须大于等于 0')
    if not isinstance(frames, (list, tuple)):
        raise ValueError('frames 必须是帧列表')

    for frame_index, frame in enumerate(frames):
        if not isinstance(frame, dict) or not isinstance(frame.get('spots'), (list, tuple)):
            raise ValueError(f'第 {frame_index + 1} 帧 spots 格式无效')
        spots = frame['spots']
        if len(spots) != 3:
            raise ValueError(f'第 {frame_index + 1} 帧必须包含三个 spots')
        coordinates = []
        for spot in spots:
            if not isinstance(spot, dict) or 'x_um' not in spot or 'y_um' not in spot:
                raise ValueError(f'第 {frame_index + 1} 帧 spot 坐标格式无效')
            coordinates.append((
                _finite_number(spot['x_um'], 'x_um'),
                _finite_number(spot['y_um'], 'y_um'),
            ))

        for left_index, left in enumerate(coordinates):
            for right_index, right in enumerate(coordinates[left_index + 1:], left_index + 1):
                distance = math.hypot(left[0] - right[0], left[1] - right[1])
                if distance < minimum:
                    raise ValueError(
                        f'第 {frame_index + 1} 帧光斑 {left_index + 1} 与 '
                        f'{right_index + 1} 的距离小于最小间距 {minimum:g} μm'
                    )
    return None
