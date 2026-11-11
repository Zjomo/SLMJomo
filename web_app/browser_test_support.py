"""Start the Flask app with temporary storage for browser regression runs."""

from contextlib import contextmanager
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time

from sqlalchemy.engine import URL
from werkzeug.serving import make_server


@contextmanager
def isolated_app_server():
    if 'app' in sys.modules:
        raise RuntimeError('Run browser checks in a fresh Python process.')

    temporary = tempfile.TemporaryDirectory(prefix='slmjomo-browser-')
    root = Path(temporary.name)
    database_path = root / 'browser.sqlite'
    output_dir = root / 'output'
    output_dir.mkdir()
    variable_names = ('SLMJOMO_DATABASE_URI', 'SLMJOMO_OUTPUT_DIR')
    previous_values = {name: os.environ.get(name) for name in variable_names}
    web_app = None
    server = None
    thread = None
    try:
        os.environ['SLMJOMO_DATABASE_URI'] = URL.create(
            'sqlite', database=str(database_path)
        ).render_as_string(hide_password=False)
        os.environ['SLMJOMO_OUTPUT_DIR'] = str(output_dir)
        try:
            import app as web_app
        finally:
            for name, value in previous_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        web_app.app.config['TESTING'] = True
        with web_app.app.app_context():
            actual_database = Path(web_app.db.engine.url.database).resolve()
            if actual_database != database_path.resolve():
                raise RuntimeError(
                    f'Browser regression database is not isolated: {actual_database}'
                )
            if Path(web_app.OUTPUT_DIR).resolve() != output_dir.resolve():
                raise RuntimeError(
                    f'Browser regression output is not isolated: {web_app.OUTPUT_DIR}'
                )
            web_app.db.create_all()
            web_app.init_default_presets()

        server = make_server('127.0.0.1', 0, web_app.app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        address = server.server_address
        for _ in range(100):
            try:
                with socket.create_connection(address, timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError('The isolated Flask server did not start.')

        yield f'http://{address[0]}:{address[1]}/', root
    finally:
        for name, value in previous_values.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        if server is not None:
            server.shutdown()
        if thread is not None:
            thread.join(timeout=5)
        if web_app is not None:
            with web_app.app.app_context():
                web_app.db.session.remove()
                web_app.db.engine.dispose()
        temporary.cleanup()
