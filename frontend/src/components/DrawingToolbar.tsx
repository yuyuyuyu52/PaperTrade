import { useState } from "react";
import "./DrawingToolbar.css";

export interface DrawingTool {
  id: "line" | "fib" | "rectangle" | "none";
  label: string;
  icon: string;
}

const TOOLS: DrawingTool[] = [
  { id: "none", label: "选择", icon: "↖️" },
  { id: "line", label: "直线", icon: "╱" },
  { id: "fib", label: "Fib分割", icon: "⋰" },
  { id: "rectangle", label: "矩形", icon: "▭" },
];

interface DrawingToolbarProps {
  activeTool: DrawingTool["id"];
  onToolChange: (tool: DrawingTool["id"]) => void;
  onClearDrawings: () => void;
}

export function DrawingToolbar({
  activeTool,
  onToolChange,
  onClearDrawings,
}: DrawingToolbarProps) {
  return (
    <div className="drawing-toolbar">
      <div className="toolbar-buttons">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={`toolbar-button ${activeTool === tool.id ? "active" : ""}`}
            onClick={() => onToolChange(tool.id)}
            title={tool.label}
          >
            <span className="button-icon">{tool.icon}</span>
            <span className="button-label">{tool.label}</span>
          </button>
        ))}
      </div>
      <div className="toolbar-divider" />
      <button
        className="toolbar-button danger"
        onClick={onClearDrawings}
        title="清除所有绘图"
      >
        <span className="button-icon">🗑️</span>
        <span className="button-label">清除</span>
      </button>
    </div>
  );
}

export default DrawingToolbar;
