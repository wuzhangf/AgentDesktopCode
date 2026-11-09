// ECharts React host (§7.3, §9.2):按需导入, init once, dispose on unmount,
// ResizeObserver for size, stable series.id for incremental updates,
// animation honours the motion preference, aria enabled.
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import {
  BarChart, LineChart, PieChart, ScatterChart, HeatmapChart,
  BoxplotChart, SankeyChart, CustomChart,
} from 'echarts/charts';
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
  AriaComponent, MarkLineComponent, MarkPointComponent, TitleComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { motionPref } from '../../lib/motion';

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, BoxplotChart,
  SankeyChart, CustomChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
  AriaComponent, MarkLineComponent, MarkPointComponent, TitleComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export { echarts };

export function ChartHost({ option, height = 240, onClickPoint, ariaLabel }: {
  option: Record<string, unknown>;
  height?: number;
  onClickPoint?: (params: { seriesId?: string; dataIndex?: number; name?: string; value?: unknown }) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClickPoint);
  clickRef.current = onClickPoint;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    chart.on('click', (p: unknown) => {
      const cp = p as { seriesId?: string; dataIndex?: number; name?: string; value?: unknown };
      clickRef.current?.(cp);
    });
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const anim = motionPref() === 'standard';
    chart.setOption(
      { ...option, animation: anim && option['animation'] !== false },
      { notMerge: false, lazyUpdate: true },
    );
  }, [option]);

  return (
    <div ref={ref} style={{ height, width: '100%' }} role="img"
      aria-label={ariaLabel ?? '图表'} />
  );
}
