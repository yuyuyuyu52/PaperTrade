import { ChangeEvent } from "react";
import { Candle, Instrument, Interval, Mode } from "../types";

interface PlaybackControls {
  isPlaying: boolean;
  cursorIndex: number;
  onToggle: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onSeek: (index: number) => void;
}

interface ControlsPanelProps {
  instruments: Instrument[];
  selectedSymbol: string;
  onSymbolChange: (symbol: string) => void;
  interval: Interval;
  onIntervalChange: (interval: Interval) => void;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  playbackControls: PlaybackControls;
  playbackTimeline: Candle[];
}

const intervals: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function ControlsPanel({
  instruments,
  selectedSymbol,
  onSymbolChange,
  interval,
  onIntervalChange,
  mode,
  onModeChange,
  playbackControls,
  playbackTimeline
}: ControlsPanelProps) {
  const handleSymbol = (event: ChangeEvent<HTMLSelectElement>) => {
    onSymbolChange(event.target.value);
  };
  const handleInterval = (event: ChangeEvent<HTMLSelectElement>) => {
    onIntervalChange(event.target.value as Interval);
  };
  const handleMode = (event: ChangeEvent<HTMLSelectElement>) => {
    onModeChange(event.target.value as Mode);
  };

  const handleSeek = (event: ChangeEvent<HTMLInputElement>) => {
    playbackControls.onSeek(Number(event.target.value));
  };

  return (
    <div className="controls-panel">
      <div className="control-group">
        <label htmlFor="symbol">品种</label>
        <select id="symbol" value={selectedSymbol} onChange={handleSymbol}>
          {instruments.map((instrument) => (
            <option key={instrument.symbol} value={instrument.symbol}>
              {instrument.name}
            </option>
          ))}
        </select>
      </div>

      <div className="control-group">
        <label htmlFor="interval">时间级别</label>
        <select id="interval" value={interval} onChange={handleInterval}>
          {intervals.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div className="control-group">
        <label htmlFor="mode">模式</label>
        <select id="mode" value={mode} onChange={handleMode}>
          <option value="realtime">实时模式</option>
          <option value="playback">回放模式</option>
        </select>
      </div>

      {mode === "playback" && (
        <div className="playback-controls">
          <button type="button" onClick={playbackControls.onStepBackward}>
            ⏮️
          </button>
          <button type="button" onClick={playbackControls.onToggle}>
            {playbackControls.isPlaying ? "⏸️" : "▶️"}
          </button>
          <button type="button" onClick={playbackControls.onStepForward}>
            ⏭️
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, playbackTimeline.length - 1)}
            value={playbackControls.cursorIndex}
            onChange={handleSeek}
            className="timeline-slider"
          />
          <span className="timeline-label">
            {playbackTimeline.length > 0
              ? new Date(playbackTimeline[playbackControls.cursorIndex]?.time * 1000).toLocaleString()
              : "--"}
          </span>
        </div>
      )}
    </div>
  );
}

export default ControlsPanel;
