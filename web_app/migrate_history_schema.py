"""Back up the configured SQLite database and add history parameter storage."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app import app, db, migrate_generation_history_schema


def create_database_backup(database_path):
    source_path = Path(database_path).resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f'SQLite database not found: {source_path}')

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_path = source_path.with_name(
        f'{source_path.stem}.before-history-migration-{timestamp}{source_path.suffix}'
    )
    if backup_path.exists():
        raise FileExistsError(f'Backup already exists: {backup_path}')

    source = sqlite3.connect(str(source_path))
    backup = sqlite3.connect(str(backup_path))
    try:
        source.backup(backup)
    finally:
        backup.close()
        source.close()
    return backup_path


def main():
    with app.app_context():
        database_path = db.engine.url.database
        if not database_path or database_path == ':memory:':
            raise RuntimeError('A file-backed SQLite database is required')
        backup_path = create_database_backup(database_path)
        try:
            migrate_generation_history_schema(db.engine)
        except Exception:
            raise RuntimeError(
                f'History migration failed; restore or inspect backup: {backup_path}'
            ) from None
    print(f'History migration completed. SQLite backup: {backup_path}')


if __name__ == '__main__':
    main()
