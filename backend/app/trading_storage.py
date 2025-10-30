"""Trading system storage layer."""

import sqlite3
import json
from typing import Optional, List, Dict, Tuple
from datetime import datetime

from .config import DATA_DIR
from .trading_models import Account, Order, Position, Trade, AccountStats

DB_PATH = DATA_DIR / "trading.db"


def _connect() -> sqlite3.Connection:
    """Create database connection."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_trading_db() -> None:
    """Initialize trading database tables."""
    with _connect() as conn:
        # 账户表
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                initial_balance REAL NOT NULL,
                balance REAL NOT NULL,
                created_time INTEGER NOT NULL,
                last_update_time INTEGER NOT NULL,
                UNIQUE(mode, symbol, interval)
            )
            """
        )
        
        # 仓位表
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                quantity REAL NOT NULL,
                entry_price REAL NOT NULL,
                entry_time INTEGER NOT NULL,
                take_profit_price REAL,
                stop_loss_price REAL,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )
            """
        )
        # 兼容旧表：尝试添加列（若已存在会抛错，忽略即可）
        try:
            conn.execute("ALTER TABLE positions ADD COLUMN take_profit_price REAL")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE positions ADD COLUMN stop_loss_price REAL")
        except Exception:
            pass
        
        # 订单表
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                type TEXT NOT NULL,
                quantity REAL NOT NULL,
                price REAL,
                create_time INTEGER NOT NULL,
                filled_time INTEGER,
                filled_quantity REAL DEFAULT 0,
                filled_price REAL,
                status TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )
            """
        )
        
        # 成交记录表
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                quantity REAL NOT NULL,
                price REAL NOT NULL,
                timestamp INTEGER NOT NULL,
                commission REAL DEFAULT 0,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )
            """
        )

        # 已平仓持仓记录表 - 记录完整的交易（从建仓到平仓）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS closed_positions (
                id TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                quantity REAL NOT NULL,
                entry_price REAL NOT NULL,
                entry_time INTEGER NOT NULL,
                exit_price REAL NOT NULL,
                exit_time INTEGER NOT NULL,
                profit_loss REAL NOT NULL,
                commission REAL DEFAULT 0,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )
            """
        )
        
        # 统计数据表
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL UNIQUE,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                losing_trades INTEGER DEFAULT 0,
                win_rate REAL DEFAULT 0,
                total_profit REAL DEFAULT 0,
                total_loss REAL DEFAULT 0,
                profit_factor REAL DEFAULT 0,
                expectancy REAL DEFAULT 0,
                max_drawdown REAL DEFAULT 0,
                max_drawdown_pct REAL DEFAULT 0,
                sharpe_ratio REAL DEFAULT 0,
                cagr REAL DEFAULT 0,
                cumulative_return REAL DEFAULT 0,
                total_return REAL DEFAULT 0,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )
            """
        )
        
        conn.commit()


def get_or_create_account(mode: str, symbol: str, interval: str, initial_balance: float = 10000.0) -> Tuple[int, Account]:
    """Get or create account."""
    with _connect() as conn:
        cursor = conn.execute(
            "SELECT id FROM accounts WHERE mode = ? AND symbol = ? AND interval = ?",
            (mode, symbol, interval)
        )
        row = cursor.fetchone()
        
        if row:
            account_id = row["id"]
            account = _load_account(account_id)
            return account_id, account
        
        # Create new account
        now = int(datetime.utcnow().timestamp())
        cursor = conn.execute(
            """
            INSERT INTO accounts (mode, symbol, interval, initial_balance, balance, created_time, last_update_time)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (mode, symbol, interval, initial_balance, initial_balance, now, now)
        )
        account_id = cursor.lastrowid
        conn.commit()
        
        # Create stats record
        conn.execute(
            "INSERT INTO account_stats (account_id) VALUES (?)",
            (account_id,)
        )
        conn.commit()
        
        account = Account(
            mode=mode,
            symbol=symbol,
            interval=interval,
            initial_balance=initial_balance,
            balance=initial_balance,
            created_time=now,
            last_update_time=now
        )
        return account_id, account


def _load_account(account_id: int) -> Account:
    """Load account from database."""
    with _connect() as conn:
        cursor = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,))
        row = cursor.fetchone()
        if not row:
            raise ValueError(f"Account {account_id} not found")
        
        account = Account(
            mode=row["mode"],
            symbol=row["symbol"],
            interval=row["interval"],
            initial_balance=row["initial_balance"],
            balance=row["balance"],
            created_time=row["created_time"],
            last_update_time=row["last_update_time"]
        )
        
        # Load positions
        cursor = conn.execute("SELECT * FROM positions WHERE account_id = ?", (account_id,))
        for row in cursor:
            keys = set(row.keys())
            pos = Position(
                symbol=row["symbol"],
                quantity=row["quantity"],
                entry_price=row["entry_price"],
                entry_time=row["entry_time"],
                take_profit_price=row["take_profit_price"] if "take_profit_price" in keys else None,
                stop_loss_price=row["stop_loss_price"] if "stop_loss_price" in keys else None,
            )
            account.positions.append(pos)
        
        # Load orders
        cursor = conn.execute("SELECT * FROM orders WHERE account_id = ?", (account_id,))
        for row in cursor:
            order = Order(
                id=row["id"],
                symbol=row["symbol"],
                direction=row["direction"],
                type=row["type"],
                quantity=row["quantity"],
                price=row["price"],
                create_time=row["create_time"],
                filled_time=row["filled_time"],
                filled_quantity=row["filled_quantity"],
                filled_price=row["filled_price"],
                status=row["status"]
            )
            account.orders.append(order)
        
        # Load trades
        cursor = conn.execute("SELECT * FROM trades WHERE account_id = ?", (account_id,))
        for row in cursor:
            trade = Trade(
                id=row["id"],
                symbol=row["symbol"],
                direction=row["direction"],
                quantity=row["quantity"],
                price=row["price"],
                timestamp=row["timestamp"],
                commission=row["commission"]
            )
            account.trades.append(trade)
        
        # Load closed positions
        cursor = conn.execute("SELECT * FROM closed_positions WHERE account_id = ?", (account_id,))
        for row in cursor:
            from .trading_models import ClosedPosition
            closed_pos = ClosedPosition(
                id=row["id"],
                symbol=row["symbol"],
                direction=row["direction"],
                quantity=row["quantity"],
                entry_price=row["entry_price"],
                entry_time=row["entry_time"],
                exit_price=row["exit_price"],
                exit_time=row["exit_time"],
                profit_loss=row["profit_loss"],
                commission=row["commission"]
            )
            account.closed_positions.append(closed_pos)
        
        return account


def save_account(account_id: int, account: Account) -> None:
    """Save account to database."""
    with _connect() as conn:
        now = int(datetime.utcnow().timestamp())
        
        # Update account
        conn.execute(
            """
            UPDATE accounts 
            SET balance = ?, last_update_time = ?
            WHERE id = ?
            """,
            (account.balance, now, account_id)
        )
        
        # Clear and update positions
        conn.execute("DELETE FROM positions WHERE account_id = ?", (account_id,))
        for pos in account.positions:
            conn.execute(
                """
                INSERT INTO positions (account_id, symbol, quantity, entry_price, entry_time, take_profit_price, stop_loss_price)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (account_id, pos.symbol, pos.quantity, pos.entry_price, pos.entry_time, pos.take_profit_price, pos.stop_loss_price)
            )
        
        # Clear and update closed positions
        conn.execute("DELETE FROM closed_positions WHERE account_id = ?", (account_id,))
        for closed_pos in account.closed_positions:
            conn.execute(
                """
                INSERT INTO closed_positions 
                (id, account_id, symbol, direction, quantity, entry_price, entry_time, exit_price, exit_time, profit_loss, commission)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (closed_pos.id, account_id, closed_pos.symbol, closed_pos.direction, closed_pos.quantity,
                 closed_pos.entry_price, closed_pos.entry_time, closed_pos.exit_price, closed_pos.exit_time,
                 closed_pos.profit_loss, closed_pos.commission)
            )
        
        conn.commit()


def save_order(account_id: int, order: Order) -> None:
    """Save order to database."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO orders 
            (id, account_id, symbol, direction, type, quantity, price, create_time, 
             filled_time, filled_quantity, filled_price, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (order.id, account_id, order.symbol, order.direction, order.type, order.quantity,
             order.price, order.create_time, order.filled_time, order.filled_quantity,
             order.filled_price, order.status)
        )
        conn.commit()


def save_trade(account_id: int, trade: Trade) -> None:
    """Save trade to database."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO trades 
            (id, account_id, symbol, direction, quantity, price, timestamp, commission)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (trade.id, account_id, trade.symbol, trade.direction, trade.quantity,
             trade.price, trade.timestamp, trade.commission)
        )
        conn.commit()


def save_account_stats(account_id: int, stats: AccountStats) -> None:
    """Save account stats to database."""
    with _connect() as conn:
        conn.execute(
            """
            UPDATE account_stats 
            SET total_trades = ?, winning_trades = ?, losing_trades = ?, win_rate = ?,
                total_profit = ?, total_loss = ?, profit_factor = ?, expectancy = ?,
                max_drawdown = ?, max_drawdown_pct = ?, sharpe_ratio = ?, cagr = ?,
                cumulative_return = ?, total_return = ?
            WHERE account_id = ?
            """,
            (stats.total_trades, stats.winning_trades, stats.losing_trades, stats.win_rate,
             stats.total_profit, stats.total_loss, stats.profit_factor, stats.expectancy,
             stats.max_drawdown, stats.max_drawdown_pct, stats.sharpe_ratio, stats.cagr,
             stats.cumulative_return, stats.total_return, account_id)
        )
        conn.commit()


def get_account_stats(account_id: int) -> Optional[AccountStats]:
    """Get account stats from database."""
    with _connect() as conn:
        cursor = conn.execute("SELECT * FROM account_stats WHERE account_id = ?", (account_id,))
        row = cursor.fetchone()
        if not row:
            return None
        
        return AccountStats(
            total_trades=row["total_trades"],
            winning_trades=row["winning_trades"],
            losing_trades=row["losing_trades"],
            win_rate=row["win_rate"],
            total_profit=row["total_profit"],
            total_loss=row["total_loss"],
            profit_factor=row["profit_factor"],
            expectancy=row["expectancy"],
            max_drawdown=row["max_drawdown"],
            max_drawdown_pct=row["max_drawdown_pct"],
            sharpe_ratio=row["sharpe_ratio"],
            cagr=row["cagr"],
            cumulative_return=row["cumulative_return"],
            total_return=row["total_return"]
        )


def get_account_id(mode: str, symbol: str, interval: str) -> Optional[int]:
    """Get account ID by mode, symbol, interval."""
    with _connect() as conn:
        cursor = conn.execute(
            "SELECT id FROM accounts WHERE mode = ? AND symbol = ? AND interval = ?",
            (mode, symbol, interval)
        )
        row = cursor.fetchone()
        return row["id"] if row else None
