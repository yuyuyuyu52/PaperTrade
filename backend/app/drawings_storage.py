"""Storage for drawings."""
import json
import sqlite3
from typing import List, Optional
from .models import Drawing


def get_drawings_db_path() -> str:
    """Get the path to the drawings database."""
    import os
    db_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(db_dir, "drawings.db")


def init_drawings_db() -> None:
    """Initialize the drawings database."""
    db_path = get_drawings_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS drawings (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            interval TEXT,
            tool TEXT NOT NULL,
            points TEXT NOT NULL,
            color TEXT,
            lineWidth INTEGER,
            properties TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Best-effort add interval column for existing DBs
    try:
        cursor.execute("ALTER TABLE drawings ADD COLUMN interval TEXT")
    except sqlite3.OperationalError:
        pass
    
    conn.commit()
    conn.close()


def save_drawing(drawing: Drawing) -> None:
    """Save a drawing to the database."""
    db_path = get_drawings_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
        INSERT OR REPLACE INTO drawings 
        (id, symbol, interval, tool, points, color, lineWidth, properties)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        drawing.id,
        drawing.symbol,
        getattr(drawing, 'interval', None),
        drawing.tool,
        json.dumps(drawing.points),
        drawing.color,
        drawing.lineWidth,
        json.dumps(drawing.properties) if drawing.properties else None,
    ))
    
    conn.commit()
    conn.close()


def get_drawings(symbol: str, interval: Optional[str] = None) -> List[Drawing]:
    """Get drawings for a symbol, optionally filtered by interval."""
    db_path = get_drawings_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    if interval:
        cursor.execute(
            """
            SELECT * FROM drawings 
            WHERE symbol = ? AND (interval = ? OR interval IS NULL OR interval = '')
            ORDER BY created_at ASC
            """,
            (symbol, interval),
        )
    else:
        cursor.execute(
            """
            SELECT * FROM drawings 
            WHERE symbol = ?
            ORDER BY created_at ASC
            """,
            (symbol,),
        )
    
    rows = cursor.fetchall()
    conn.close()
    
    drawings: List[Drawing] = []
    for row in rows:
        drawing = Drawing(
            id=row["id"],
            symbol=row["symbol"],
            interval=row["interval"] or "",
            tool=row["tool"],
            points=json.loads(row["points"]),
            color=row["color"],
            lineWidth=row["lineWidth"],
            properties=json.loads(row["properties"]) if row["properties"] else None,
        )
        drawings.append(drawing)
    
    return drawings


def delete_drawing(drawing_id: str) -> bool:
    """Delete a drawing by ID."""
    db_path = get_drawings_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM drawings WHERE id = ?", (drawing_id,))
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    
    return affected > 0


def delete_all_drawings(symbol: str, interval: Optional[str] = None) -> int:
    """Delete drawings for a symbol, optionally filtered by interval."""
    db_path = get_drawings_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    if interval:
        cursor.execute(
            "DELETE FROM drawings WHERE symbol = ? AND (interval = ? OR interval IS NULL OR interval = '')",
            (symbol, interval),
        )
    else:
        cursor.execute(
            "DELETE FROM drawings WHERE symbol = ?",
            (symbol,),
        )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    
    return affected
