# TradingView-Style Chart Application

Trading chart web application featuring a FastAPI backend and a React (Vite) frontend. Users can view ETH/BTC candlestick charts with configurable intervals, switch between real-time streaming and historical playback modes, and control playback with intuitive UI controls.

## Features

- FastAPI backend providing REST endpoints for instruments, candle data, and historical ranges.
- WebSocket endpoint streaming up-to-date Binance candles per instrument/interval using Binance's realtime stream (`wss://stream.binance.com:9443/ws`).
- React + Vite frontend using `lightweight-charts` for candlestick rendering with custom styling.
- Real-time mode keeps the chart filled with the most recent candles while streaming partial (in-flight) Binance updates and backfilling older history on demand.
- Playback mode exposes the full historical timeline, slider-based seeking, and play/pause controls.
- Dark wick/outline and green bullish bodies on a light gray chart background, matching the specification.
- Local SQLite cache of Binance candles for fast repeat access and offline-friendly playback.

## Project Structure

```
backend/          # FastAPI application
frontend/         # React + Vite SPA
.vscode/tasks.json
```

## Prerequisites

- Python 3.12 (virtual environment configured in `.venv`)
- Node.js 18+

## Setup

```bash
# Install backend dependencies
pip install -r backend/requirements.txt

# Install frontend dependencies
cd frontend
npm install
```

## Running in Development

Two VS Code tasks are provided (`backend:dev`, `frontend:dev`). Alternatively run manually:

```bash
# Backend (from repository root)
./.venv/bin/uvicorn app.main:app --reload --app-dir backend

# Frontend
cd frontend
npm run dev
```

Access the UI at `http://localhost:5173`. The Vite dev server proxies API/WebSocket calls to `http://127.0.0.1:8000`.

## Data Source & Storage

- Candle data is fetched from the Binance spot REST API (`ETHUSDT`, `BTCUSDT`) on demand.
- Responses are cached in a local SQLite database at `backend/data/candles.db` to accelerate future requests.
- The WebSocket stream polls Binance for fresh candles, persists them, then pushes updates downstream.

## Building for Production

```bash
cd frontend
npm run build
```

The command outputs static assets under `frontend/dist/`. Serve them with a static server and point them to the FastAPI API.

## Testing Checklist

- Run `python -m compileall backend/app` to confirm backend syntax integrity.
- Run `npm run build` to ensure the frontend compiles.

## Next Steps

- Broaden instrument coverage or allow user-managed watchlists.
- Add configurable playback speed and keyboard shortcuts.
- Implement alerts or indicators computed on cached data.

## Contributor

- yuyuyuyu52
- jiangmy