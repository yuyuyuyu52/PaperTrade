"""Simple async events bus for trading updates."""
import asyncio
from typing import Dict, List, Any, Optional

_SUBSCRIBERS: Dict[int, List[asyncio.Queue]] = {}
_LOCK = asyncio.Lock()
_EVENT_LOOP: Optional[asyncio.AbstractEventLoop] = None


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _EVENT_LOOP
    _EVENT_LOOP = loop

async def subscribe(account_id: int) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    async with _LOCK:
        _SUBSCRIBERS.setdefault(account_id, []).append(queue)
    return queue

async def unsubscribe(account_id: int, queue: asyncio.Queue) -> None:
    async with _LOCK:
        lst = _SUBSCRIBERS.get(account_id, [])
        if queue in lst:
            lst.remove(queue)
        if not lst and account_id in _SUBSCRIBERS:
            _SUBSCRIBERS.pop(account_id, None)

def _safe_put(queue: asyncio.Queue, payload: Dict[str, Any]) -> None:
    try:
        queue.put_nowait(payload)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
        except Exception:
            pass
        try:
            queue.put_nowait(payload)
        except Exception:
            pass

async def notify(account_id: int, payload: Dict[str, Any]) -> None:
    async with _LOCK:
        targets = list(_SUBSCRIBERS.get(account_id, []))
    if not targets:
        return
    for q in targets:
        _safe_put(q, payload)


def dispatch(account_id: int, payload: Dict[str, Any]) -> None:
    """Schedule an event notification in a thread-safe manner."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        if _EVENT_LOOP is None:
            raise RuntimeError("Events bus loop not registered")
        asyncio.run_coroutine_threadsafe(notify(account_id, payload), _EVENT_LOOP)
    else:
        loop.create_task(notify(account_id, payload))
